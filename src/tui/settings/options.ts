import type { DialogSelectOption } from "@opencode/plugin/tui/context"

import { formatTokens } from "../../shared/format.ts"
import type { Messages } from "../../i18n/index.ts"
import {
  effectiveDecompressInlineMax,
  effectiveDecompressTempCap,
  effectiveDecompressTempMaxAgeHours,
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
  "decompressTempMaxAgeHours",
  "decompressShowTokens",
  "language",
] as const

export type SettingsAction = (typeof SETTINGS_ACTIONS)[number]

/** 全局默认下的五个分组；顺序即菜单顺序。 */
export const SETTINGS_GROUPS = ["compress", "summary", "panel", "decompress", "interface"] as const

export type SettingsGroup = (typeof SETTINGS_GROUPS)[number]

/** 每个动作属于哪个分组；用于三层菜单里过滤。 */
export const ACTION_GROUPS: Record<SettingsAction, SettingsGroup> = {
  limit: "compress",
  threshold: "compress",
  nudge: "compress",
  autoCompress: "compress",
  enableCompressTool: "compress",
  enableDecompressTool: "compress",
  blockPercent: "summary",
  totalPercent: "summary",
  summaryLanguage: "summary",
  summaryFormat: "summary",
  showTimeline: "summary",
  showBlockTokens: "summary",
  show: "panel",
  showCacheChart: "panel",
  showCacheLog: "panel",
  showSummaries: "panel",
  decompressInlineMax: "decompress",
  decompressTempCap: "decompress",
  decompressTempMaxAgeHours: "decompress",
  decompressShowTokens: "decompress",
  language: "interface",
}

/** 输入：全部选项 + 分组；输出：该分组的选项。预期：保持原有顺序。 */
export function itemsOfGroup(
  options: readonly DialogSelectOption<SettingsAction>[],
  group: SettingsGroup,
): readonly DialogSelectOption<SettingsAction>[] {
  return options.filter((option) => ACTION_GROUPS[option.value] === group)
}

/**
 * 输入：设置 + 文案 + 当前模型。
 * 输出：设置第一层：全局默认 / 按模型。
 * 预期：两项都带摘要，打开后一眼能看到当前阈值与当前模型。
 */
export function buildSectionOptions(input: {
  readonly settings: Settings
  readonly copy: Messages
  readonly currentModel?: string
}): readonly DialogSelectOption<"global" | "models">[] {
  const { settings, copy } = input
  const total = effectiveSummaryTotalPercent(settings)
  return [
    {
      title: copy.settings.sectionGlobal,
      value: "global",
      footer: `${copy.settings.threshold} ${settings.triggerPercent.toString()}% · ${copy.settings.summaryTotalPercent} ${total.toString()}%`,
    },
    {
      title: copy.settings.sectionModel,
      value: "models",
      footer: input.currentModel ?? copy.settings.overrideNone,
    },
  ]
}

/**
 * 输入：设置 + 文案 + 窗口。
 * 输出：全局默认下的五个分组，每组带一行摘要。
 * 预期：只显示分组，不显示具体项，避免一屏二十多行。
 */
export function buildGroupOptions(input: {
  readonly settings: Settings
  readonly copy: Messages
  readonly window: number | undefined
}): readonly DialogSelectOption<SettingsGroup>[] {
  const { settings, copy } = input
  const onOff = (value: boolean): string => (value ? copy.settings.on : copy.settings.off)
  const block = effectiveSummaryBlockPercent(settings)
  const total = effectiveSummaryTotalPercent(settings)
  const nudge = settings.nudgeGrowthTokens === 0 ? copy.settings.off : formatTokens(settings.nudgeGrowthTokens)
  return [
    {
      title: copy.settings.categories.compress,
      value: "compress",
      footer: `${settings.triggerPercent.toString()}% · ${nudge} · ${onOff(settings.autoCompress)}`,
    },
    {
      title: copy.settings.categories.summary,
      value: "summary",
      footer: `${block.toString()}% / ${total.toString()}% · ${summaryFormatLabel(settings, copy)} · ${summaryLanguageLabel(settings, copy)}`,
    },
    {
      title: copy.settings.categories.panel,
      value: "panel",
      footer: [onOff(settings.enabled), onOff(settings.showCacheChart), onOff(settings.showSummaries)].join(" · "),
    },
    {
      title: copy.settings.categories.decompress,
      value: "decompress",
      footer: `${formatTokens(effectiveDecompressInlineMax(settings))} · ${effectiveDecompressTempCap(settings).toString()} · ${effectiveDecompressTempMaxAgeHours(settings).toString()}h`,
    },
    {
      title: copy.settings.categories.interface,
      value: "interface",
      footer: localeLabel(settings, copy),
    },
  ]
}

/**
 * 输入：设置 + 文案 + 当前模型。
 * 输出：按模型第一层的两项。
 * 预期：没有当前模型时右侧显示「未识别」，点进去退回选择器。
 */
export function buildModelSectionOptions(input: {
  readonly settings: Settings
  readonly copy: Messages
  readonly currentModel?: string
}): readonly DialogSelectOption<"current" | "overrides">[] {
  const { settings, copy } = input
  return [
    {
      title: copy.settings.modelCurrent,
      value: "current",
      footer: input.currentModel ?? copy.settings.overrideNone,
    },
    {
      title: copy.settings.modelOverrides,
      value: "overrides",
      footer: copy.settings.modelsConfigured(Object.keys(settings.models).length),
    },
  ]
}

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
  /** 输入：动作 + 标题 + 右侧值 + 分组；输出：一个布尔开关项。 */
  const toggle = (
    value: SettingsAction,
    title: string,
    footer: string,
    category: string,
  ): DialogSelectOption<SettingsAction> => ({ title, value, footer, category })
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
    toggle(
      "autoCompress",
      copy.settings.autoCompress,
      onOff(settings.autoCompress),
      copy.settings.categories.compress,
    ),
    toggle(
      "enableCompressTool",
      copy.settings.enableCompressTool,
      onOff(settings.enableCompressTool),
      copy.settings.categories.compress,
    ),
    toggle(
      "enableDecompressTool",
      copy.settings.enableDecompressTool,
      onOff(settings.enableDecompressTool),
      copy.settings.categories.compress,
    ),
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
    toggle(
      "showTimeline",
      copy.settings.showTimeline,
      onOff(settings.showTimeline),
      copy.settings.categories.summary,
    ),
    toggle(
      "showBlockTokens",
      copy.settings.showBlockTokens,
      onOff(settings.showBlockTokens),
      copy.settings.categories.summary,
    ),
    toggle("show", copy.settings.show, onOff(settings.enabled), copy.settings.categories.panel),
    toggle(
      "showCacheChart",
      copy.settings.showCacheChart,
      onOff(settings.showCacheChart),
      copy.settings.categories.panel,
    ),
    toggle(
      "showCacheLog",
      copy.settings.showCacheLog,
      onOff(settings.showCacheLog),
      copy.settings.categories.panel,
    ),
    toggle(
      "showSummaries",
      copy.settings.showSummaries,
      onOff(settings.showSummaries),
      copy.settings.categories.panel,
    ),
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
      title: copy.settings.decompressTempMaxAgeHours,
      value: "decompressTempMaxAgeHours",
      footer: `${effectiveDecompressTempMaxAgeHours(settings).toString()}h`,
      category: copy.settings.categories.decompress,
    },
    toggle(
      "decompressShowTokens",
      copy.settings.decompressShowTokens,
      onOff(settings.decompressShowTokens),
      copy.settings.categories.decompress,
    ),
    {
      title: copy.settings.language,
      value: "language",
      footer: localeLabel(settings, copy),
      category: copy.settings.categories.interface,
    },
  ]
}
