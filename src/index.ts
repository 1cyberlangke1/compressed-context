import { Plugin } from "@opencode/plugin"

import { markCompactionInFlight, maybeAutoCompress, resolveLimit } from "./compression/auto.ts"
import { distillOnce, planT1Phase } from "./compression/distill.ts"
import { reconcileAll, startCompactionEvents } from "./compression/events.ts"
import { activeBlocks, renderAll } from "./compression/render.ts"
import { eligibleMessages, olderMessages, type MessageLike } from "./compression/select.ts"
import { loadServerSettings } from "./compression/settings.ts"
import { registerSettingsRpc, type Disposable } from "./compression/settings-rpc.ts"
import { resolveSummaryLimits } from "./settings.ts"
import {
  loadState,
  nextBlockId,
  nextOrder,
  saveState,
  type Block,
  type CompactionPhase,
  type State,
} from "./compression/state.ts"
import {
  buildT1Instruction,
  sessionGenerator,
  summarizeInstruction,
} from "./compression/summarize.ts"
import { registerCompressTool } from "./compression/tool.ts"
import { registerDecompressTool } from "./compression/decompress-tool.ts"
import { buildTranscript } from "./compression/transcript.ts"
import { MIN_SOURCE_CHARS, validateSummary } from "./compression/validate.ts"
import { createStats, mergeMetadata, shouldPublish, type ContextStats } from "./stats.ts"
import { estimateCategories } from "./tokens.ts"

export default Plugin.define({
  id: "compressed-context",

  /**
   * 输入：OpenCode 注入的插件上下文 ctx。
   * 输出：注册 compress 工具、设置 RPC、context / compaction 钩子与事件订阅。
   * 预期：块链通过 compaction 落盘；失败不破坏历史。
   */
  async setup(ctx) {
    const cache = new Map<string, readonly MessageLike[]>()
    const published = new Map<string, ContextStats>()
    const disposables: Disposable[] = []

    const publishStats = async (sessionID: string, stats: ContextStats): Promise<void> => {
      const session = await ctx.session.get({ sessionID })
      await ctx.session.update({
        sessionID,
        metadata: mergeMetadata(session.metadata, stats),
      })
    }

    disposables.push(await registerCompressTool(ctx, cache))
    disposables.push(await registerDecompressTool(ctx))
    disposables.push(await registerSettingsRpc(ctx))
    const stopEvents = startCompactionEvents(ctx)
    void reconcileAll(ctx)

    disposables.push(
      await ctx.session.hook("context", (event) => {
        const eligible = eligibleMessages(event.messages)
        cache.set(event.sessionID, eligible)

        const stats = createStats(
          estimateCategories({
            system: event.system,
            tools: event.tools,
            messages: event.messages,
          }),
          Date.now(),
        )
        if (shouldPublish(published.get(event.sessionID), stats)) {
          published.set(event.sessionID, stats)
          void publishStats(event.sessionID, stats).catch(() => undefined)
        }

        void maybeAutoCompress({
          ctx,
          sessionID: event.sessionID,
          messages: event.messages,
          system: event.system,
          tools: event.tools,
          model: event.model,
        })
      }),
    )

    disposables.push(
      await ctx.session.hook("compaction", async (event) => {
        markCompactionInFlight(event.sessionID, true)
        try {
        const state = await loadState(ctx.storage, event.sessionID)
        const settings = await loadServerSettings(ctx.storage)
        // auto 窗口在运行时解析后钳制摘要上限；数字窗口已在保存时校验，这里统一再钳一次。
        const windowTokens = await resolveLimit(ctx, event.model, settings.contextLimit)
        const limits = resolveSummaryLimits(settings, windowTokens)

        /** 保存这一层的结果；pending 可选，phase 由下一层决定。 */
        const save = async (
          blocks: readonly Block[],
          pending: Block | undefined,
          phase: CompactionPhase | undefined,
          error: string | undefined,
        ): Promise<void> => {
          const base: State = {
            v: 1,
            blocks,
            attempts: state.attempts,
            ...(state.autoInFlight === undefined ? {} : { autoInFlight: state.autoInFlight }),
            ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
            ...(phase === undefined ? {} : { phase }),
          }
          const next: State = pending === undefined ? base : { ...base, pending }
          await saveState(
            ctx.storage,
            event.sessionID,
            error === undefined ? next : { ...next, lastError: error },
          )
        }

        // 第二阶段：T2/T3。只在 older 里没有真实消息时合并——此时新对话由 OpenCode
        // 原样保留在 checkpoint 的 recent 里，合并只处理块，不会丢内容。
        // 有真实消息时走下面的 T1：先总结新内容，phase 留到下一次压缩再合并。
        if (state.phase !== undefined && olderMessages(event.messages).length === 0) {
          const result = await distillOnce({
            ctx,
            sessionID: event.sessionID,
            state,
            pending: state.pending,
            budgetTokens: limits.budgetTokens,
            summaryBlockChars: limits.blockChars,
            summaryTotalChars: limits.totalChars,
            summaryLanguage: settings.summaryLanguage,
            phase: state.phase,
          })
          await save(result.blocks, result.pending, result.nextPhase, result.error)
          event.result = { summary: result.summary }
          return
        }

        // 第一阶段：T1。已有 pending（compress 工具）就直接用；
        // 否则用 session 前缀 + 尾部指令生成，保持前缀缓存。
        let pending = state.pending
        if (pending === undefined) {
          const eligible = olderMessages(event.messages)
          const transcript = buildTranscript(eligible)
          const sourceChars = transcript.length
          if (eligible.length === 0 || sourceChars < MIN_SOURCE_CHARS) {
            throw new Error("nothing to compress")
          }
          let failure = "unknown"
          const summary = await summarizeInstruction({
            prompt: buildT1Instruction({
              maxChars: limits.blockChars,
              totalChars: limits.totalChars,
              language: settings.summaryLanguage,
            }),
            sourceChars,
            maxChars: limits.blockChars,
            generate: sessionGenerator(ctx.session, event.sessionID),
            onFailure: (reason) => {
              failure = reason
            },
          })
          if (summary === undefined) throw new Error(`compression failed: ${failure}`)
          const validation = validateSummary(
            summary,
            sourceChars,
            undefined,
            limits.blockChars,
          )
          if (!validation.ok) throw new Error(validation.message)

          const first = eligible.find((message) => message.id !== undefined)
          const last = [...eligible].reverse().find((message) => message.id !== undefined)
          if (first?.id === undefined || last?.id === undefined) throw new Error("messages are missing ids")

          pending = {
            id: nextBlockId(state.blocks),
            tier: 1,
            summary,
            fromId: first.id,
            toId: last.id,
            tokensBefore: Math.ceil(sourceChars / 4),
            tokensAfter: Math.ceil(JSON.stringify(summary).length / 4),
            at: Date.now(),
            order: nextOrder(state.blocks),
          }
        }

        // T1 之后再检查预算；没超就不排 T2。
        const active = activeBlocks(state.blocks, pending)
        const summary = renderAll(state.blocks, pending)
        const nextPhase = planT1Phase(
          summary,
          active,
          limits.budgetTokens,
          limits.totalChars,
        )
        await save(state.blocks, pending, nextPhase, undefined)
        event.result = { summary }
        } catch (error) {
          // 把钩子里的真实异常留给失败事件和 TUI；不要只留下“compaction failed”。
          const current = await loadState(ctx.storage, event.sessionID)
          await saveState(ctx.storage, event.sessionID, {
            ...current,
            lastError: error instanceof Error ? (error.stack ?? error.message) : String(error),
          })
          throw error
        } finally {
          markCompactionInFlight(event.sessionID, false)
        }
      }),
    )

    return () => {
      stopEvents()
      for (const disposable of disposables) void disposable.dispose()
    }
  },
})
