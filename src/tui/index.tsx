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
    summaryBlockPercent: settings.summaryBlockPercent,
    summaryTotalPercent: settings.summaryTotalPercent,
    summaryLanguage: settings.summaryLanguage,
    autoCompress: settings.autoCompress,
    enableCompressTool: settings.enableCompressTool,
    enableDecompressTool: settings.enableDecompressTool,
    showTimeline: settings.showTimeline,
    showBlockTokens: settings.showBlockTokens,
    cacheExpanded: settings.cacheExpanded,
    showCacheChart: settings.showCacheChart,
    cacheChartExpanded: settings.cacheChartExpanded,
    showCacheLog: settings.showCacheLog,
    cacheLogExpanded: settings.cacheLogExpanded,
    showSummaries: settings.showSummaries,
    summariesExpanded: settings.summariesExpanded,
    ...(settings.expandedBlockId === undefined ? {} : { expandedBlockId: settings.expandedBlockId }),
    decompressInlineMax: settings.decompressInlineMax,
    decompressTempCap: settings.decompressTempCap,
    decompressShowTokens: settings.decompressShowTokens,
  })
  if (
    settings.enabled === normalized.enabled &&
    settings.expanded === normalized.expanded &&
    settings.locale === normalized.locale &&
    settings.contextLimit === normalized.contextLimit &&
    settings.triggerPercent === normalized.triggerPercent &&
    settings.summaryBlockPercent === normalized.summaryBlockPercent &&
    settings.summaryTotalPercent === normalized.summaryTotalPercent &&
    settings.summaryLanguage === normalized.summaryLanguage &&
    settings.autoCompress === normalized.autoCompress &&
    settings.enableCompressTool === normalized.enableCompressTool &&
    settings.enableDecompressTool === normalized.enableDecompressTool &&
    settings.showTimeline === normalized.showTimeline &&
    settings.showBlockTokens === normalized.showBlockTokens &&
    settings.cacheExpanded === normalized.cacheExpanded &&
    settings.showCacheChart === normalized.showCacheChart &&
    settings.cacheChartExpanded === normalized.cacheChartExpanded &&
    settings.showCacheLog === normalized.showCacheLog &&
    settings.cacheLogExpanded === normalized.cacheLogExpanded &&
    settings.showSummaries === normalized.showSummaries &&
    settings.summariesExpanded === normalized.summariesExpanded &&
    settings.expandedBlockId === normalized.expandedBlockId &&
    settings.decompressInlineMax === normalized.decompressInlineMax &&
    settings.decompressTempCap === normalized.decompressTempCap &&
    settings.decompressShowTokens === normalized.decompressShowTokens
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
