import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import type { Component } from "solid-js"
import { createStore, reconcile } from "solid-js/store"

import { contextRpc, rpcLocation } from "../shared/rpc.ts"
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from "../shared/settings.ts"
import { configFileLayers } from "./config-layers.ts"
import { applySettingsMutation, snapshotSettings } from "./settings-draft.ts"
import { maybePromptNativeCompaction } from "./native-compaction-dialog.ts"
import { CachePanel, ModelPanel, Panel, SummaryPanel } from "./panel/panels.tsx"
import { SettingsCommand } from "./settings.tsx"
import type { UpdateSettings } from "./types.ts"

/** 侧栏分区组件共用的 props。 */
interface SidebarPanelProps {
  readonly context: Context
  readonly sessionID: string
  readonly settings: Settings
  readonly updateSettings: UpdateSettings
}

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
    // 每次调用现算路由：setup 时 context.location 可能还没就绪，不能把它固化成常量。
    const callOptions = (): ReturnType<typeof rpcLocation> => rpcLocation(context)
    let initial = DEFAULT_SETTINGS
    try {
      initial = normalizeSettings({ ...(await rpc.settingsGet({ layers }, callOptions())) })
    } catch {
      // 服务端插件尚未加载：先用默认值，保存时再报错。
    }
    const [settings, setSettings] = createStore<Settings>(initial)
    const updateSettings: UpdateSettings = async (mutation) => {
      // 必须连 models 一起浅拷贝：单独 spread store 时 models 仍是 store 的代理，
      // 往里写新键会被忽略，保存出去的 models 永远是空的。
      const previous: Settings = snapshotSettings(settings)
      const next = applySettingsMutation(settings, mutation)
      setSettings(reconcile(next))
      try {
        const result = await rpc.settingsSet({ ...next, layers }, callOptions())
        if (!result.ok) throw new Error(result.error ?? "settings write failed")
      } catch (error) {
        setSettings(reconcile(previous))
        context.ui.toast.show({
          message: error instanceof Error ? error.message : String(error),
          variant: "error",
        })
      }
    }

    // 三个分区各注册成独立 slot：宿主 sidebar.content 的 gap 负责分区之间的空行。
    const panels: readonly Component<SidebarPanelProps>[] = [ModelPanel, Panel, CachePanel, SummaryPanel]
    const disposePanels = panels.map((Section) =>
      context.ui.slot({
        append: "sidebar.content",
        render: (input) => (
          <Section
            context={context}
            sessionID={input.sessionID}
            settings={settings}
            updateSettings={updateSettings}
          />
        ),
      }),
    )

    const disposeCommand = context.ui.slot({
      append: "app",
      render: () => <SettingsCommand context={context} settings={settings} updateSettings={updateSettings} />,
    })

    // 等 UI 挂载后再弹；检测或弹窗失败都不阻塞插件启动。
    setTimeout(() => {
      void maybePromptNativeCompaction(context, settings, updateSettings).catch(() => undefined)
    }, 0)

    return () => {
      for (const dispose of disposePanels) dispose()
      disposeCommand()
    }
  },
})
