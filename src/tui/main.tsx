import { Plugin } from "@opencode/plugin/tui"
import { createStore, reconcile } from "solid-js/store"

import { contextRpc } from "../shared/rpc.ts"
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from "../shared/settings.ts"
import { configFileLayers } from "./config-layers.ts"
import { maybePromptNativeCompaction } from "./native-compaction-dialog.ts"
import { CachePanel, Panel, SummaryPanel } from "./panel/panels.tsx"
import { SettingsCommand } from "./settings.tsx"
import type { UpdateSettings } from "./types.ts"

export default Plugin.define({
  id: "compressed-context.tui",

  /**
   * 输入：TUI 插件上下文。
   * 输出：侧栏面板 + /compressed-context 设置命令。
   * 预期：设置从插件 JSONC 读取；写入失败回滚并提示。
   */
  async setup(context) {
    const layers = await configFileLayers(context)
    const rpc = contextRpc(context.client)
    let initial = DEFAULT_SETTINGS
    try {
      initial = normalizeSettings({ ...(await rpc.settingsGet({ layers })) })
    } catch {
      // 服务端插件尚未加载：先用默认值，保存时再报错。
    }
    const [settings, setSettings] = createStore<Settings>(initial)
    const updateSettings: UpdateSettings = async (mutation) => {
      const previous = { ...settings }
      const draft = { ...settings }
      mutation(draft)
      const next = normalizeSettings(draft)
      setSettings(reconcile(next))
      try {
        const result = await rpc.settingsSet({ ...next, layers })
        if (!result.ok) throw new Error(result.error ?? "settings write failed")
      } catch (error) {
        setSettings(reconcile(previous))
        context.ui.toast.show({
          message: error instanceof Error ? error.message : String(error),
          variant: "error",
        })
      }
    }

    const disposeContext = context.ui.slot({
      append: "sidebar.content",
      render: (input) => (
        <Panel
          context={context}
          sessionID={input.sessionID}
          settings={settings}
          updateSettings={updateSettings}
        />
      ),
    })

    const disposeCache = context.ui.slot({
      append: "sidebar.content",
      render: (input) => (
        <CachePanel
          context={context}
          sessionID={input.sessionID}
          settings={settings}
          updateSettings={updateSettings}
        />
      ),
    })

    const disposeSummaries = context.ui.slot({
      append: "sidebar.content",
      render: (input) => (
        <SummaryPanel
          context={context}
          sessionID={input.sessionID}
          settings={settings}
          updateSettings={updateSettings}
        />
      ),
    })

    const disposeCommand = context.ui.slot({
      append: "app",
      render: () => <SettingsCommand context={context} settings={settings} updateSettings={updateSettings} />,
    })

    // 等 UI 挂载后再弹；检测或弹窗失败都不阻塞插件启动。
    setTimeout(() => {
      void maybePromptNativeCompaction(context, settings, updateSettings).catch(() => undefined)
    }, 0)

    return () => {
      disposeContext()
      disposeCache()
      disposeSummaries()
      disposeCommand()
    }
  },
})
