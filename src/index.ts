import { Plugin } from "@opencode/plugin"

import { maybeAutoCompress } from "./compression/auto.ts"
import { handleCompaction } from "./compression/compaction.ts"
import { reconcileAll, startSessionEvents } from "./compression/events.ts"
import { eligibleMessages, type MessageLike } from "./compression/select.ts"
import { registerSettingsRpc, type Disposable } from "./compression/settings-rpc.ts"
import { loadState } from "./compression/state.ts"
import { registerCompressTool } from "./compression/tool.ts"
import { registerDecompressTool } from "./compression/decompress-tool.ts"
import { createStats, mergeMetadata, shouldPublish, type ContextStats } from "./shared/stats.ts"
import { estimateCategories } from "./shared/tokens.ts"

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
    /** 内存里最多保留多少个会话的 eligible 消息；超出丢最旧。 */
    const CACHE_LIMIT = 32

    /** 输入：sessionID + eligible；输出：无；预期：刷新插入顺序并限制 Map 大小。 */
    const rememberEligible = (sessionID: string, eligible: readonly MessageLike[]): void => {
      cache.delete(sessionID)
      cache.set(sessionID, eligible)
      while (cache.size > CACHE_LIMIT) {
        const oldest = cache.keys().next().value
        if (oldest === undefined) break
        cache.delete(oldest)
      }
    }

    /** 输入：sessionID；输出：无；预期：会话空闲/删除时清掉进程内缓存。 */
    const forgetMemory = (sessionID: string): void => {
      cache.delete(sessionID)
      published.delete(sessionID)
    }

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
    const stopEvents = startSessionEvents(ctx, {
      onSessionIdle: forgetMemory,
      onSessionDeleted: forgetMemory,
    })
    void reconcileAll(ctx)

    disposables.push(
      await ctx.session.hook("context", (event) => {
        const eligible = eligibleMessages(event.messages)
        rememberEligible(event.sessionID, eligible)

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
      await ctx.session.hook("compaction", (event) => handleCompaction(ctx, event)),
    )

    // 终止后拒绝一切新输入：把真实原因直接抛给宿主，TUI 会显示这条错误。
    disposables.push(
      await ctx.session.hook("prompt", async (event) => {
        const state = await loadState(ctx.storage, event.sessionID)
        if (state.terminal !== undefined) throw new Error(state.terminal)
      }),
    )

    return () => {
      stopEvents()
      for (const disposable of disposables) void disposable.dispose()
    }
  },
})
