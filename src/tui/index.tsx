import { Plugin } from "@opencode/plugin/tui"

import { initialSettings, normalizeSettings, type Settings } from "../settings.ts"
import { Panel } from "./panel.tsx"
import { SettingsCommand } from "./settings.tsx"
import type { UpdateSettings } from "./types.ts"

/**
 * 输入：当前设置 + 写入函数。
 * 输出：无。
 * 预期：旧版本存下来的设置可能缺字段（例如没有 contextLimit），补齐并写回。
 */
function migrate(settings: Settings, update: UpdateSettings): void {
  const normalized = normalizeSettings({
    enabled: settings.enabled,
    expanded: settings.expanded,
    locale: settings.locale,
    contextLimit: settings.contextLimit,
    triggerPercent: settings.triggerPercent,
    summaryBudgetTokens: settings.summaryBudgetTokens,
  })
  if (
    settings.enabled === normalized.enabled &&
    settings.expanded === normalized.expanded &&
    settings.locale === normalized.locale &&
    settings.contextLimit === normalized.contextLimit &&
    settings.triggerPercent === normalized.triggerPercent &&
    settings.summaryBudgetTokens === normalized.summaryBudgetTokens
  ) {
    return
  }
  void update((draft) => {
    Object.assign(draft, normalized)
  })
}

export default Plugin.define({
  id: "compressed-context.tui",

  /**
   * 输入：TUI 插件上下文（含插件 options）。
   * 输出：侧栏面板 + /compressed-context 设置命令。
   * 预期：设置存在 TUI storage 里；options 只作为首次默认值。
   */
  setup(context) {
    const [settings, updateSettings] = context.storage.store<Settings>("settings", {
      initial: initialSettings(context.options),
    })
    migrate(settings, updateSettings)

    const disposePanel = context.ui.slot({
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

    const disposeCommand = context.ui.slot({
      append: "app",
      render: () => <SettingsCommand context={context} settings={settings} updateSettings={updateSettings} />,
    })

    return () => {
      disposePanel()
      disposeCommand()
    }
  },
})
