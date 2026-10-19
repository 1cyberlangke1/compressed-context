import { Plugin } from "@opencode/plugin"

import { maybeAutoCompress } from "./compression/auto.ts"
import { distillOnce, mergeCandidates } from "./compression/distill.ts"
import { reconcileAll, startCompactionEvents } from "./compression/events.ts"
import { activeBlocks, renderAll } from "./compression/render.ts"
import { eligibleMessages, type MessageLike } from "./compression/select.ts"
import { loadServerSettings } from "./compression/settings.ts"
import { registerSettingsRpc, type Disposable } from "./compression/settings-rpc.ts"
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
import { buildTranscript } from "./compression/transcript.ts"
import { MIN_SOURCE_CHARS, validateSummary } from "./compression/validate.ts"
import { createStats, mergeMetadata, shouldPublish, type ContextStats } from "./stats.ts"
import { countText, estimateCategories } from "./tokens.ts"

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
        const state = await loadState(ctx.storage, event.sessionID)
        const settings = await loadServerSettings(ctx.storage)

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

        // 第二阶段：T2/T3。只合并一对，然后决定是否排下一层。
        if (state.phase !== undefined) {
          const result = await distillOnce({
            ctx,
            sessionID: event.sessionID,
            state,
            pending: state.pending,
            budgetTokens: settings.summaryBudgetTokens,
            phase: state.phase,
          })
          await save(result.blocks, result.pending, result.nextPhase, result.error)
          event.result = { summary: result.summary }
          if (result.nextPhase !== undefined) {
            await ctx.session.compact({ sessionID: event.sessionID })
          }
          return
        }

        // 第一阶段：T1。已有 pending（compress 工具）就直接用；
        // 否则用 session 前缀 + 尾部指令生成，保持前缀缓存。
        let pending = state.pending
        if (pending === undefined) {
          const eligible = eligibleMessages(event.messages)
          const transcript = buildTranscript(eligible)
          const sourceChars = transcript.length
          if (eligible.length === 0 || sourceChars < MIN_SOURCE_CHARS) {
            throw new Error("nothing to compress")
          }
          const summary = await summarizeInstruction({
            prompt: buildT1Instruction(),
            sourceChars,
            generate: sessionGenerator(ctx.session, event.sessionID),
          })
          if (summary === undefined) throw new Error("compression failed")
          const validation = validateSummary(summary, sourceChars)
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
        const nextPhase: CompactionPhase | undefined =
          countText(summary) > settings.summaryBudgetTokens && mergeCandidates(active).length > 0
            ? "t2"
            : undefined
        await save(state.blocks, pending, nextPhase, undefined)
        event.result = { summary }
        if (nextPhase !== undefined) {
          await ctx.session.compact({ sessionID: event.sessionID })
        }
      }),
    )

    return () => {
      stopEvents()
      for (const disposable of disposables) void disposable.dispose()
    }
  },
})
