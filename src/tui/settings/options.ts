import type { DialogSelectOption } from "@opencode/plugin/tui/context"

import { formatTokens } from "../../shared/format.ts"
import type { Messages } from "../../i18n/index.ts"
import {
  effectiveDecompressInlineMax,
  effectiveDecompressTempCap,
  effectiveSummaryBlockPercent,
  effectiveSummaryLanguage,
  effectiveSummaryTotalPercent,
  isContextLimit,
  percentToChars,
  type Settings,
} from "../../shared/settings.ts"

/** 输入：设置；输出：当前语言标签；预期：用于设置菜单右侧的当前值。 */
export function localeLabel(settings: Settings, copy: Messages): string {
  if (settings.locale === "auto") return copy.settings.auto
  if (settings.locale === "zh") return copy.languages.zh
  return copy.languages.en
}

/** 输入：设置；输出：当前摘要语言标签。 */
export function summaryLanguageLabel(settings: Settings, copy: Messages): string {
  const language = effectiveSummaryLanguage(settings)
  if (language === "zh") return copy.languages.zh
  if (language === "en") return copy.languages.en
  return copy.settings.auto
}

/** 输入：设置 + 已知窗口；输出：上下文上限标签；数字设置是上限，被模型原生窗口压低时显示箭头。 */
export function limitLabel(settings: Settings, copy: Messages, window: number | undefined): string {
  const value: unknown = settings.contextLimit
  if (!isContextLimit(value) || value === "auto") {
    return window === undefined ? copy.settings.limitAuto : `${copy.settings.limitAuto} (${formatTokens(window)})`
  }
  if (window !== undefined && window < value) {
    return copy.settings.limitCapped(formatTokens(value), formatTokens(window))
  }
  return formatTokens(value)
}

/** 输入：百分比 + 窗口；输出：`10% ≈ 20k` 这样的标签。 */
export function percentLabel(percent: number, window: number | undefined): string {
  const chars = percentToChars(percent, window)
  return chars === undefined
    ? `${percent.toString()}%`
    : `${percent.toString()}% ≈ ${formatTokens(chars)}`
}

/** 输入：设置；输出：主动压缩提醒间隔标签；0 显示为关闭。 */
export function nudgeLabel(settings: Settings, copy: Messages): string {
  return settings.nudgeGrowthTokens === 0 ? copy.settings.off : formatTokens(settings.nudgeGrowthTokens)
}

/** 输入：设置；输出：当前摘要格式标签。 */
export function summaryFormatLabel(settings: Settings, copy: Messages): string {
  if (settings.summaryFormat === "babel") return copy.settings.summaryFormatBabel
  return settings.summaryFormat === "markdown"
    ? copy.settings.summaryFormatMarkdown
    : copy.settings.summaryFormatJson
}

/** 设置菜单里所有可选 action；options.ts 与 settings.tsx 共用。 */
export const SETTINGS_ACTIONS = [
  "limit",
  "threshold",
  "nudge",
  "autoCompress",
  "enableCompressTool",
  "enableDecompressTool",
  "blockPercent",
  "totalPercent",
  "summaryLanguage",
  "summaryFormat",
  "showTimeline",
  "showBlockTokens",
  "show",
  "showCacheChart",
  "showCacheLog",
  "showSummaries",
  "decompressInlineMax",
  "decompressTempCap",
  "decompressShowTokens",
  "language",
] as const

export type SettingsAction = (typeof SETTINGS_ACTIONS)[number]

/** 设置菜单里可切换的布尔项。 */
export type ToggleSetting = Extract<
  SettingsAction,
  | "autoCompress"
  | "enableCompressTool"
  | "enableDecompressTool"
  | "showTimeline"
  | "showBlockTokens"
  | "showCacheChart"
  | "showCacheLog"
  | "showSummaries"
  | "decompressShowTokens"
>

/**
 * 输入：当前设置 + 文案 + 已解析窗口。
 * 输出：按「压缩 / 摘要 / 面板 / 解压 / 界面」分组的设置菜单项。
 * 预期：纯函数，方便单测；dialog 会按 category 渲染分组标题。
 */
export function buildSettingsOptions(input: {
  readonly settings: Settings
  readonly copy: Messages
  readonly window: number | undefined
}): readonly DialogSelectOption<SettingsAction>[] {
  const { settings, copy, window } = input
  const onOff = (value: boolean): string => (value ? copy.settings.on : copy.settings.off)
  return [
    {
      title: copy.settings.limit,
      value: "limit",
      footer: limitLabel(settings, copy, window),
      category: copy.settings.categories.compress,
    },
    {
      title: copy.settings.threshold,
      value: "threshold",
      footer: `${settings.triggerPercent.toString()}%`,
      category: copy.settings.categories.compress,
    },
    {
      title: copy.settings.nudgeGrowth,
      value: "nudge",
      footer: nudgeLabel(settings, copy),
      category: copy.settings.categories.compress,
    },
    {
      title: copy.settings.autoCompress,
      value: "autoCompress",
      footer: onOff(settings.autoCompress),
      category: copy.settings.categories.compress,
    },
    {
      title: copy.settings.enableCompressTool,
      value: "enableCompressTool",
      footer: onOff(settings.enableCompressTool),
      category: copy.settings.categories.compress,
    },
    {
      title: copy.settings.enableDecompressTool,
      value: "enableDecompressTool",
      footer: onOff(settings.enableDecompressTool),
      category: copy.settings.categories.compress,
    },
    {
      title: copy.settings.summaryBlockPercent,
      value: "blockPercent",
      footer: percentLabel(effectiveSummaryBlockPercent(settings), window),
      category: copy.settings.categories.summary,
    },
    {
      title: copy.settings.summaryTotalPercent,
      value: "totalPercent",
      footer: percentLabel(effectiveSummaryTotalPercent(settings), window),
      category: copy.settings.categories.summary,
    },
    {
      title: copy.settings.summaryLanguage,
      value: "summaryLanguage",
      footer: summaryLanguageLabel(settings, copy),
      category: copy.settings.categories.summary,
    },
    {
      title: copy.settings.summaryFormat,
      value: "summaryFormat",
      footer: summaryFormatLabel(settings, copy),
      category: copy.settings.categories.summary,
    },
    {
      title: copy.settings.showTimeline,
      value: "showTimeline",
      footer: onOff(settings.showTimeline),
      category: copy.settings.categories.summary,
    },
    {
      title: copy.settings.showBlockTokens,
      value: "showBlockTokens",
      footer: onOff(settings.showBlockTokens),
      category: copy.settings.categories.summary,
    },
    {
      title: copy.settings.show,
      value: "show",
      footer: onOff(settings.enabled),
      category: copy.settings.categories.panel,
    },
    {
      title: copy.settings.showCacheChart,
      value: "showCacheChart",
      footer: onOff(settings.showCacheChart),
      category: copy.settings.categories.panel,
    },
    {
      title: copy.settings.showCacheLog,
      value: "showCacheLog",
      footer: onOff(settings.showCacheLog),
      category: copy.settings.categories.panel,
    },
    {
      title: copy.settings.showSummaries,
      value: "showSummaries",
      footer: onOff(settings.showSummaries),
      category: copy.settings.categories.panel,
    },
    {
      title: copy.settings.decompressInlineMax,
      value: "decompressInlineMax",
      footer: formatTokens(effectiveDecompressInlineMax(settings)),
      category: copy.settings.categories.decompress,
    },
    {
      title: copy.settings.decompressTempCap,
      value: "decompressTempCap",
      footer: effectiveDecompressTempCap(settings).toString(),
      category: copy.settings.categories.decompress,
    },
    {
      title: copy.settings.decompressShowTokens,
      value: "decompressShowTokens",
      footer: onOff(settings.decompressShowTokens),
      category: copy.settings.categories.decompress,
    },
    {
      title: copy.settings.language,
      value: "language",
      footer: localeLabel(settings, copy),
      category: copy.settings.categories.interface,
    },
  ]
}
