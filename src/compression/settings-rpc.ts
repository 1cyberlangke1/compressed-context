import type { Plugin } from "@opencode/plugin"

import { ContextRpc } from "../rpc.ts"
import { loadServerSettings, parseServerSettings, saveServerSettings } from "./settings.ts"

/** 注册句柄的最小结构。 */
export interface Disposable {
  dispose(): Promise<void>
}

/**
 * 输入：服务端插件上下文。
 * 输出：注册 settingsGet / settingsSet，并返回注销句柄。
 * 预期：TUI 推来的设置存进 ctx.storage；非法值返回 ok:false。
 */
export async function registerSettingsRpc(ctx: Plugin.Context): Promise<Disposable> {
  return ctx.rpc.register(ContextRpc, {
    settingsGet: async () => {
      const settings = await loadServerSettings(ctx.storage)
      return { contextLimit: settings.contextLimit, triggerPercent: settings.triggerPercent }
    },
    settingsSet: async (input) => {
      const parsed = parseServerSettings(input)
      if (!parsed) return { ok: false }
      await saveServerSettings(ctx.storage, parsed)
      return { ok: true }
    },
  })
}
