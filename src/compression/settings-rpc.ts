import type { Plugin } from "@opencode/plugin"

import { ContextRpc } from "../rpc.ts"
import {
  RESOLVED_WINDOW_KEY,
  loadServerSettings,
  parseServerSettings,
  saveServerSettings,
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
    settingsGet: async () => {
      const settings = await loadServerSettings(ctx.storage)
      const resolved = await ctx.storage.get(RESOLVED_WINDOW_KEY)
      const resolvedWindow = typeof resolved === "number" && resolved > 0 ? resolved : undefined
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
