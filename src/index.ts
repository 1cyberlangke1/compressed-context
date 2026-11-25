import { Plugin } from "@opencode/plugin"

import { maybeAutoCompress, maybeAutoCompressStep, maybeNudge } from "./compression/auto.ts"
import { recordCacheHistoryStep, recordCacheHistoryUsage } from "./compression/cache-history.ts"
import { dropTracker } from "./compression/cache-drops.ts"
import { adoptNativeCheckpoint } from "./compression/adopt.ts"
import { handleCompaction } from "./compression/compaction.ts"
import { cleanupStaleTempFiles } from "./compression/decompress.ts"
import { reconcileAll, startSessionEvents } from "./compression/events.ts"
import { loadServerSettings } from "./compression/settings.ts"
import { hideTools, isSubagentSession } from "./compression/session-role.ts"
import { updateSessionMetadata } from "./compression/session-metadata.ts"
import { registerSettingsRpc, type Disposable } from "./compression/settings-rpc.ts"
import { registerCompressTool } from "./compression/tool.ts"
import { registerDecompressTool } from "./compression/decompress-tool.ts"
import { registerCheckpointTreeTool } from "./compression/checkpoint-tree-tool.ts"
import { calibrationCoefs, recordCalibration, type CalibrationSample } from "./compression/calibration.ts"
import { effectiveDecompressTempMaxAgeHours } from "./shared/settings.ts"
import { usageFromWireBody } from "./shared/wire-usage.ts"
import { createStats, mergeMetadata, shouldPublish, type ContextStats } from "./shared/stats.ts"
import { estimateBuckets, estimateCategories } from "./shared/tokens.ts"

export default Plugin.define({
  id: "compressed-context",

  /**
   * 输入：OpenCode 注入的插件上下文 ctx。
   * 输出：注册 compress 工具、设置 RPC、context / compaction 钩子与事件订阅。
   * 预期：块链通过 compaction 落盘；失败不破坏历史。
   */
  async setup(ctx) {
    const published = new Map<string, ContextStats>()
    /** 最近一次 context 钩子算出的字符构成：等这一步的 usage 回来时作校准样本。 */
    const pendingSamples = new Map<
      string,
      { readonly model: { readonly providerID: string; readonly id: string }; readonly sample: Omit<CalibrationSample, "realTokens">; readonly at: number }
    >()
    const SAMPLE_MAX_AGE_MS = 10 * 60_000
    const disposables: Disposable[] = []
    // 清理上一个进程留下的解压临时文件；保留期由当前设置决定，默认 24 小时。
    const initialSettings = await loadServerSettings(ctx)
    cleanupStaleTempFiles({
      maxAgeMs: effectiveDecompressTempMaxAgeHours(initialSettings) * 60 * 60 * 1000,
    })

    /** 输入：sessionID；输出：无；预期：会话空闲/删除时清掉进程内统计缓存与请求追踪。 */
    const forgetMemory = (sessionID: string): void => {
      published.delete(sessionID)
      dropTracker().forget(sessionID)
    }

    const publishStats = async (sessionID: string, stats: ContextStats): Promise<void> => {
      // metadata 是整体替换语义；统计和终止原因可能同时写，必须串行合并。
      await updateSessionMetadata(ctx, sessionID, (metadata) => mergeMetadata(metadata, stats))
    }

    const compressTool = await registerCompressTool(ctx)
    disposables.push(compressTool)
    disposables.push(await registerDecompressTool(ctx))
    disposables.push(await registerCheckpointTreeTool(ctx))
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
          const pending = pendingSamples.get(sessionID)
          if (pending !== undefined && Date.now() - pending.at <= SAMPLE_MAX_AGE_MS) {
            pendingSamples.delete(sessionID)
            await recordCalibration(ctx.storage, pending.model, {
              buckets: pending.sample.buckets,
              mediaTokens: pending.sample.mediaTokens,
              realTokens: tokens.input + tokens.cache.read + tokens.cache.write,
            })
          }
          await maybeAutoCompressStep({ ctx, sessionID, tokens })
        })(),
    })
    // 工具注册后刷新一次工具表，让已存在的会话在下一次请求也能看到 compress。
    await ctx.tool.reload()
    void reconcileAll(ctx)

    // 工具注册表是目录级共享的：开关关闭或子代理会话时，必须在发给模型前删键，
    // 否则子代理也能调用 compress/decompress，压掉自己短命会话里的细节。
    // 三条请求路径都要覆盖：context（普通对话）、compaction（原生压缩）、
    // generate（插件自己的摘要请求，走 summarize.ts 的 session.generate）。
    const applyToolPolicy = async (input: {
      readonly sessionID: string
      readonly tools: Record<string, unknown>
    }): Promise<void> => {
      const roleHidden = await isSubagentSession(ctx, input.sessionID)
      const settings = await loadServerSettings(ctx)
      // 子代理、或者对应开关关掉：都不该把工具广告给模型。
      if (roleHidden || !settings.enableCompressTool) hideTools(input.tools, ["compress"])
      if (roleHidden || !settings.enableDecompressTool) hideTools(input.tools, ["decompress"])
      if (roleHidden || !settings.enableCheckpointTreeTool) hideTools(input.tools, ["checkpoint_tree"])
    }

    disposables.push(
      await ctx.session.hook("context", async (event) => {
        await applyToolPolicy({ sessionID: event.sessionID, tools: event.tools })

        await adoptNativeCheckpoint(ctx, event.sessionID, event.messages)

        await maybeNudge({
          ctx,
          sessionID: event.sessionID,
          messages: event.messages,
          system: event.system,
          tools: event.tools,
          model: event.model,
        })

        // 估算用该模型自己学到的系数：显示与压缩阈值共用同一套数字。
        const coefs = await calibrationCoefs(ctx.storage, event.model)
        const stats = createStats(
          estimateCategories(
            {
              system: event.system,
              tools: event.tools,
              messages: event.messages,
            },
            coefs,
          ),
          Date.now(),
        )
        // 记下这次请求的字符构成：usage 回来后按同一份统计校准系数。
        pendingSamples.set(event.sessionID, {
          model: { providerID: event.model.providerID, id: event.model.id },
          sample: {
            buckets: estimateBuckets({ system: event.system, tools: event.tools, messages: event.messages }),
            mediaTokens: stats.media,
          },
          at: Date.now(),
        })
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
      await ctx.session.hook("compaction", async (event) => {
        // 原生压缩请求走这里而非 context：同样的隐藏逻辑必须生效。
        await applyToolPolicy({ sessionID: event.sessionID, tools: event.tools })
        return handleCompaction(ctx, event)
      }),
    )

    disposables.push(
      await ctx.session.hook("generate", async (event) => {
        // 插件自己的摘要请求走 generate 流：不隐藏的话，子代理的摘要请求
        // 仍然会向模型广告 compress/decompress/checkpoint_tree。
        await applyToolPolicy({ sessionID: event.sessionID, tools: event.tools })
      }),
    )

    // 缓存突变记录：开关打开时抓所有用途的原始报文（primary / compaction /
    // generate / title）。克隆请求体不会消费宿主稍后要读的那一份。
    disposables.push(
      await ctx.session.hook("http.request", async (event) => {
        const settings = await loadServerSettings(ctx)
        if (!settings.cacheDropsEnabled) {
          dropTracker().forget(event.sessionID)
          return
        }
        // 子代理会话短命，侧栏不展示；不抓它的报文，省内存也避免噪声。
        if (await isSubagentSession(ctx, event.sessionID)) return
        try {
          const body = await event.request.clone().text()
          dropTracker().capture(event.sessionID, { body, at: Date.now(), kind: event.kind })
        } catch {
          // 请求体读失败只影响这条记录，不影响真正发出去的请求。
        }
      }),
    )

    // 压缩 / 标题 / generate 没有统一 usage 事件：从响应报文里解析。
    // 必须 fire-and-forget：await 读 body 会卡住宿主流式输出。
    disposables.push(
      await ctx.session.hook("http.response", async (event) => {
        if (event.kind === "primary") return
        const settings = await loadServerSettings(ctx)
        if (!settings.cacheDropsEnabled) return
        if (await isSubagentSession(ctx, event.sessionID)) return
        const sessionID = event.sessionID
        const kind = event.kind
        const model = `${event.model.providerID}/${event.model.id}`
        const sampleID = `${kind}:${Date.now().toString(36)}`
        void event.response
          .clone()
          .text()
          .then((text) => {
            const tokens = usageFromWireBody(text)
            if (tokens === undefined) return undefined
            return recordCacheHistoryUsage(ctx, sessionID, { sampleID, kind, tokens, model })
          })
          .catch(() => undefined)
      }),
    )

    return () => {
      stopEvents()
      for (const disposable of disposables) void disposable.dispose()
    }
  },
})
