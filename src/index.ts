import { Plugin } from "@opencode/plugin"

import { maybeAutoCompress } from "./compression/auto.ts"
import { distillChain } from "./compression/distill.ts"
import { reconcileAll, startCompactionEvents } from "./compression/events.ts"
import { eligibleMessages, type MessageLike } from "./compression/select.ts"
import { loadServerSettings } from "./compression/settings.ts"
import { registerSettingsRpc, type Disposable } from "./compression/settings-rpc.ts"
import { loadState, nextBlockId, nextOrder, saveState, type Block } from "./compression/state.ts"
import { summarize, type GenerateLike } from "./compression/summarize.ts"
import { registerCompressTool } from "./compression/tool.ts"
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
        let pending: Block
        if (state.pending) {
          pending = state.pending
        } else {
          const eligible = eligibleMessages(event.messages)
          const transcript = buildTranscript(eligible)
          const sourceChars = transcript.length
          if (eligible.length === 0 || sourceChars < MIN_SOURCE_CHARS) {
            throw new Error("nothing to compress")
          }
          const summary = await summarize({
            transcript,
            sourceChars,
            generate: ctx.generate as unknown as GenerateLike,
            model: event.model,
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

        // 全部同步做完：T1 后先看摘要预算，没超就直接返回；
        // 超了就在同一个钩子里继续 T2/T3，压完才让模型继续。
        const settings = await loadServerSettings(ctx.storage)
        const result = await distillChain({
          ctx,
          model: event.model,
          state,
          pending,
          budgetTokens: settings.summaryBudgetTokens,
        })
        await saveState(ctx.storage, event.sessionID, {
          v: 1,
          blocks: result.blocks,
          pending: result.pending,
          attempts: state.attempts,
          ...(result.error === undefined ? {} : { lastError: result.error }),
        })
        event.result = { summary: result.summary }
      }),
    )

    return () => {
      stopEvents()
      for (const disposable of disposables) void disposable.dispose()
    }
  },
})
