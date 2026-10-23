import { Plugin } from "@opencode/plugin"

import { maybeAutoCompress, maybeAutoCompressStep, maybeNudge } from "./compression/auto.ts"
import { recordCacheHistoryStep } from "./compression/cache-history.ts"
import { adoptNativeCheckpoint } from "./compression/adopt.ts"
import { handleCompaction } from "./compression/compaction.ts"
import { cleanupStaleTempFiles } from "./compression/decompress.ts"
import { reconcileAll, startSessionEvents } from "./compression/events.ts"
import { loadServerSettings } from "./compression/settings.ts"
import { registerSettingsRpc, type Disposable } from "./compression/settings-rpc.ts"
import { loadState } from "./compression/state.ts"
import { registerCompressTool } from "./compression/tool.ts"
import { registerDecompressTool } from "./compression/decompress-tool.ts"
import { effectiveDecompressTempMaxAgeHours } from "./shared/settings.ts"
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
    const published = new Map<string, ContextStats>()
    const disposables: Disposable[] = []
    // 清理上一个进程留下的解压临时文件；保留期由当前设置决定，默认 24 小时。
    const initialSettings = await loadServerSettings(ctx)
    cleanupStaleTempFiles({
      maxAgeMs: effectiveDecompressTempMaxAgeHours(initialSettings) * 60 * 60 * 1000,
    })

    /** 输入：sessionID；输出：无；预期：会话空闲/删除时清掉进程内统计缓存。 */
    const forgetMemory = (sessionID: string): void => {
      published.delete(sessionID)
    }

    const publishStats = async (sessionID: string, stats: ContextStats): Promise<void> => {
      const session = await ctx.session.get({ sessionID })
      await ctx.session.update({
        sessionID,
        metadata: mergeMetadata(session.metadata, stats),
      })
    }

    const compressTool = await registerCompressTool(ctx)
    disposables.push(compressTool)
    disposables.push(await registerDecompressTool(ctx))
    // 摘要格式存在设置里；保存后让 compress 工具的描述与参数立刻跟着换。
    disposables.push(
      await registerSettingsRpc(ctx, {
        onSaved: (settings) => compressTool.setFormat(settings.summaryFormat),
      }),
    )
    const stopEvents = startSessionEvents(ctx, {
      onSessionIdle: forgetMemory,
      onSessionDeleted: forgetMemory,
      onStepEnded: ({ sessionID, messageID, tokens }) =>
        void (async () => {
          await recordCacheHistoryStep(ctx, sessionID, { messageID, tokens })
          await maybeAutoCompressStep({ ctx, sessionID, tokens })
        })(),
    })
    // 工具注册后刷新一次工具表，让已存在的会话在下一次请求也能看到 compress。
    await ctx.tool.reload()
    void reconcileAll(ctx)

    disposables.push(
      await ctx.session.hook("context", async (event) => {
        await adoptNativeCheckpoint(ctx, event.sessionID, event.messages)

        await maybeNudge({
          ctx,
          sessionID: event.sessionID,
          messages: event.messages,
          system: event.system,
          tools: event.tools,
          model: event.model,
        })

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

        await maybeAutoCompress({
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
