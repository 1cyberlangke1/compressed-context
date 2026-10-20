import type { Plugin } from "@opencode/plugin"

import { ContextRpc } from "../rpc.ts"
import {
  RESOLVED_WINDOW_KEY,
  loadServerSettings,
  parseServerSettings,
  saveServerSettings,
  windowKey,
} from "./settings.ts"

/** 注册句柄的最小结构。 */
export interface Disposable {
  dispose(): Promise<void>
}

/**
 * 输入：服务端插件上下文。
 * 输出：注册 settingsGet / settingsSet，并返回注销句柄。
 * 预期：TUI 推来的设置存进 ctx.storage；非法值返回 ok:false；读取时带上最近解析到的原生窗口。
 */
export async function registerSettingsRpc(ctx: Plugin.Context): Promise<Disposable> {
  return ctx.rpc.register(ContextRpc, {
    settingsGet: async (input) => {
      const settings = await loadServerSettings(ctx.storage)
      const requested = (input as { readonly sessionID?: unknown }).sessionID
      const sessionID = typeof requested === "string" && requested.length > 0 ? requested : undefined
      // 优先返回当前会话模型自己的窗口；拿不到再退回最近一次解析值。
      let resolvedWindow: number | undefined
      if (sessionID !== undefined) {
        try {
          const session = await ctx.session.get({ sessionID })
          const model = session.model
          if (model !== undefined) {
            const stored = await ctx.storage.get(windowKey(model.providerID, model.id))
            if (typeof stored === "number" && stored > 0) resolvedWindow = stored
          }
        } catch {
          // 会话不存在或模型未知：回退到最近一次解析值
        }
      }
      if (resolvedWindow === undefined) {
        const stored = await ctx.storage.get(RESOLVED_WINDOW_KEY)
        if (typeof stored === "number" && stored > 0) resolvedWindow = stored
      }
      return {
        contextLimit: settings.contextLimit,
        triggerPercent: settings.triggerPercent,
        summaryBlockPercent: settings.summaryBlockPercent,
        summaryTotalPercent: settings.summaryTotalPercent,
        summaryLanguage: settings.summaryLanguage,
        autoCompress: settings.autoCompress,
        enableCompressTool: settings.enableCompressTool,
        enableDecompressTool: settings.enableDecompressTool,
        showTimeline: settings.showTimeline,
        showBlockTokens: settings.showBlockTokens,
        decompressInlineMax: settings.decompressInlineMax,
        decompressTempCap: settings.decompressTempCap,
        decompressShowTokens: settings.decompressShowTokens,
        ...(resolvedWindow === undefined ? {} : { resolvedWindow }),
      }
    },
    settingsSet: async (input) => {
      const current = await loadServerSettings(ctx.storage)
      const parsed = parseServerSettings({ ...current, ...(input as Record<string, unknown>) })
      if (!parsed) return { ok: false }
      await saveServerSettings(ctx.storage, parsed)
      return { ok: true }
    },
  })
}
