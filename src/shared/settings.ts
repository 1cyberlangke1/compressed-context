import { readInt } from "./parse.ts"

/**
 * TUI 面板设置。
 *
 * 存在 TUI 自己的 storage 里（`context.storage.store`），用户不用改 config.json。
 * 优先级：UI 改过的值 > 插件 options 给的初始值 > 内置默认。
 *
 * 摘要上限按「窗口百分比」存储：换模型、换窗口后自动缩放，不会因为旧的绝对值放不下。
 */

export const LOCALE_SETTINGS = ["auto", "zh", "en"] as const

export type LocaleSetting = (typeof LOCALE_SETTINGS)[number]

/** 摘要语言；auto 跟随源对话。 */
export const SUMMARY_LANGUAGES = ["auto", "zh", "en"] as const

export type SummaryLanguage = (typeof SUMMARY_LANGUAGES)[number]

/** 摘要格式：JSON 结构化，或自由 Markdown。 */
export const SUMMARY_FORMATS = ["json", "markdown"] as const

export type SummaryFormat = (typeof SUMMARY_FORMATS)[number]

export const DEFAULT_SUMMARY_FORMAT: SummaryFormat = "markdown"

/** 输入：任意值；输出：是否是合法摘要格式。 */
export function isSummaryFormat(value: unknown): value is SummaryFormat {
  return typeof value === "string" && (SUMMARY_FORMATS as readonly string[]).includes(value)
}

/** 单条摘要的最小字符数；只用于把绝对值输入换算成百分比时的下界。 */
export const MIN_SUMMARY_BLOCK_CHARS = 500

/** 窗口未知时（还没拿到模型信息）退回的绝对值上限。 */
export const DEFAULT_SUMMARY_BLOCK_CHARS = 20_000
export const DEFAULT_SUMMARY_TOTAL_CHARS = 100_000

/** 摘要上限允许的窗口百分比范围。 */
export const MIN_SUMMARY_PERCENT = 1
export const MAX_SUMMARY_PERCENT = 90
export const DEFAULT_SUMMARY_BLOCK_PERCENT = 10
export const DEFAULT_SUMMARY_TOTAL_PERCENT = 50

/**
 * 上下文窗口里预留给 system/tools/recent 的 token 数。
 * 摘要上限按 1 字符 ≈ 1 token 的最坏情况折算，保证 CJK 摘要也不会撑爆窗口。
 */
export const SUMMARY_WINDOW_RESERVE = 10_000

/** 上下文窗口上限：auto 复用模型原生值，数字表示自定义 token 数。 */
export type ContextLimit = "auto" | number

export const MIN_TRIGGER_PERCENT = 60
export const MAX_TRIGGER_PERCENT = 95
export const DEFAULT_TRIGGER_PERCENT = 80

/** 主动压缩提醒的默认增长量；0 表示关闭。 */
export const DEFAULT_NUDGE_GROWTH_TOKENS = 50_000
export const MIN_NUDGE_GROWTH_TOKENS = 0
export const MAX_NUDGE_GROWTH_TOKENS = 200_000

/** 可用窗口下限：低于它连最小摘要都放不下。 */
export const MIN_CONTEXT_LIMIT = 50_000
export const MAX_CONTEXT_LIMIT = 10_000_000

/** 自动压缩总开关：关掉后只保留手动 /compact 和 compress 工具。 */
export const DEFAULT_AUTO_COMPRESS = true

/** 工具开关：关掉后工具仍注册，但调用会返回明确错误。 */
export const DEFAULT_ENABLE_COMPRESS_TOOL = true
export const DEFAULT_ENABLE_DECOMPRESS_TOOL = true

/** 块头是否显示时间线 / 估算 token；默认关闭，避免多占 token。 */
export const DEFAULT_SHOW_TIMELINE = false
export const DEFAULT_SHOW_BLOCK_TOKENS = false

/** 面板显示项；都是 TUI 本地状态，不发给服务端。 */
export const DEFAULT_CACHE_EXPANDED = true
export const DEFAULT_SHOW_CACHE_CHART = true
export const DEFAULT_CACHE_CHART_EXPANDED = true
export const DEFAULT_SHOW_CACHE_LOG = true
export const DEFAULT_CACHE_LOG_EXPANDED = false
export const DEFAULT_SHOW_SUMMARIES = true
export const DEFAULT_SUMMARIES_EXPANDED = true

/** decompress 返回分级与临时文件上限。 */
export const DEFAULT_DECOMPRESS_INLINE_MAX = 10_000
export const DEFAULT_DECOMPRESS_TEMP_CAP = 50
export const DEFAULT_DECOMPRESS_SHOW_TOKENS = true
export const MIN_DECOMPRESS_INLINE_MAX = 1_000
export const MAX_DECOMPRESS_INLINE_MAX = 1_000_000
export const MIN_DECOMPRESS_TEMP_CAP = 1
export const MAX_DECOMPRESS_TEMP_CAP = 1_000

/** 服务端关心的压缩设置；TUI 的 Settings 在此基础上加显示项。 */
export interface CompressionSettings {
  /** 上下文窗口上限；数字是上限，实际取「设置值」和「模型原生窗口」中较小的那个 */
  contextLimit: ContextLimit
  /** 强制压缩阈值（占用百分比） */
  triggerPercent: number
  /** 每增长多少 token 提醒模型可以主动压缩；0 关闭 */
  nudgeGrowthTokens: number
  /** 单条摘要最多占窗口的百分比 */
  summaryBlockPercent: number
  /** 全部摘要加起来最多占窗口的百分比 */
  summaryTotalPercent: number
  /** 摘要语言；只影响提示词 */
  summaryLanguage: SummaryLanguage
  /** 摘要格式：JSON 结构化 / Markdown 自然语言 */
  summaryFormat: SummaryFormat
  /** 自动压缩总开关 */
  autoCompress: boolean
  /** compress 工具开关 */
  enableCompressTool: boolean
  /** decompress 工具开关 */
  enableDecompressTool: boolean
  /** 块头显示时间线 */
  showTimeline: boolean
  /** 块头显示估算 token */
  showBlockTokens: boolean
  /** decompress 内联上限（字符） */
  decompressInlineMax: number
  /** decompress 临时文件上限 */
  decompressTempCap: number
  /** decompress 返回是否带估算 token */
  decompressShowTokens: boolean
}

export interface Settings extends CompressionSettings {
  /** 是否显示整块上下文面板 */
  enabled: boolean
  /** 面板是否展开（折叠后只剩标题行） */
  expanded: boolean
  /** 界面语言；auto 跟随系统 */
  locale: LocaleSetting
  /** 缓存记录区是否展开 */
  cacheExpanded: boolean
  /** 显示缓存折线图 */
  showCacheChart: boolean
  /** 折线图是否展开 */
  cacheChartExpanded: boolean
  /** 显示缓存日志 */
  showCacheLog: boolean
  /** 日志是否展开 */
  cacheLogExpanded: boolean
  /** 显示摘要块 */
  showSummaries: boolean
  /** 摘要区是否展开 */
  summariesExpanded: boolean
  /** 当前展开的摘要块 id；undefined 表示全部收起 */
  expandedBlockId?: string
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  expanded: true,
  locale: "auto",
  contextLimit: "auto",
  triggerPercent: DEFAULT_TRIGGER_PERCENT,
  nudgeGrowthTokens: DEFAULT_NUDGE_GROWTH_TOKENS,
  summaryBlockPercent: DEFAULT_SUMMARY_BLOCK_PERCENT,
  summaryTotalPercent: DEFAULT_SUMMARY_TOTAL_PERCENT,
  summaryLanguage: "auto",
  summaryFormat: DEFAULT_SUMMARY_FORMAT,
  autoCompress: DEFAULT_AUTO_COMPRESS,
  enableCompressTool: DEFAULT_ENABLE_COMPRESS_TOOL,
  enableDecompressTool: DEFAULT_ENABLE_DECOMPRESS_TOOL,
  showTimeline: DEFAULT_SHOW_TIMELINE,
  showBlockTokens: DEFAULT_SHOW_BLOCK_TOKENS,
  cacheExpanded: DEFAULT_CACHE_EXPANDED,
  showCacheChart: DEFAULT_SHOW_CACHE_CHART,
  cacheChartExpanded: DEFAULT_CACHE_CHART_EXPANDED,
  showCacheLog: DEFAULT_SHOW_CACHE_LOG,
  cacheLogExpanded: DEFAULT_CACHE_LOG_EXPANDED,
  showSummaries: DEFAULT_SHOW_SUMMARIES,
  summariesExpanded: DEFAULT_SUMMARIES_EXPANDED,
  decompressInlineMax: DEFAULT_DECOMPRESS_INLINE_MAX,
  decompressTempCap: DEFAULT_DECOMPRESS_TEMP_CAP,
  decompressShowTokens: DEFAULT_DECOMPRESS_SHOW_TOKENS,
}

/** 输入：任意值；输出：是否是合法语言设置。 */
export function isLocaleSetting(value: unknown): value is LocaleSetting {
  return typeof value === "string" && (LOCALE_SETTINGS as readonly string[]).includes(value)
}

/** 输入：任意值；输出：是否是合法摘要语言。 */
export function isSummaryLanguage(value: unknown): value is SummaryLanguage {
  return typeof value === "string" && (SUMMARY_LANGUAGES as readonly string[]).includes(value)
}

/** 输入：任意值；输出：合法的主动压缩提醒增长量；0 表示关闭。 */
export function readNudgeGrowthTokens(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  const rounded = Math.round(value)
  if (rounded === 0) return 0
  if (rounded < 1_000 || rounded > MAX_NUDGE_GROWTH_TOKENS) return fallback
  return rounded
}

/** 输入：任意值；输出：合法的窗口百分比（保留一位小数）。 */
export function readSummaryPercent(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  const rounded = Math.round(value * 10) / 10
  if (rounded < MIN_SUMMARY_PERCENT || rounded > MAX_SUMMARY_PERCENT) return fallback
  return rounded
}

/**
 * 输入：用户输入的摘要上限文本（`10%` / `20k` / `20000`）+ 当前窗口。
 * 输出：窗口百分比；非法或无法换算返回 undefined。
 * 预期：绝对值按窗口换算；窗口未知时只接受百分比写法。
 */
export function parseSummaryPercent(text: string, windowTokens: number | undefined): number | undefined {
  const trimmed = text.trim()
  if (trimmed.endsWith("%")) {
    const value = Number(trimmed.slice(0, -1))
    if (!Number.isFinite(value)) return undefined
    const percent = Math.round(value * 10) / 10
    if (percent < MIN_SUMMARY_PERCENT || percent > MAX_SUMMARY_PERCENT) return undefined
    return percent
  }
  if (windowTokens === undefined || !Number.isFinite(windowTokens) || windowTokens <= 0) return undefined
  const tokens = parseTokenCount(trimmed, MIN_SUMMARY_BLOCK_CHARS, Math.floor(windowTokens))
  if (tokens === undefined) return undefined
  const percent = Math.round((tokens / windowTokens) * 1000) / 10
  if (percent < MIN_SUMMARY_PERCENT || percent > MAX_SUMMARY_PERCENT) return undefined
  return percent
}

/** 输入：百分比 + 窗口；输出：折算后的字符上限；窗口未知返回 undefined。 */
export function percentToChars(percent: number, windowTokens: number | undefined): number | undefined {
  if (windowTokens === undefined || !Number.isFinite(windowTokens) || windowTokens <= 0) return undefined
  return Math.round((windowTokens * percent) / 100)
}

/**
 * 输入：窗口 token 数。
 * 输出：摘要百分比允许的最大值（扣掉预留）。
 * 预期：窗口未知时返回全局上限；窗口太小放不下最小摘要时返回 MIN。
 */
export function maxSummaryPercent(windowTokens: number | undefined): number {
  if (windowTokens === undefined || !Number.isFinite(windowTokens) || windowTokens <= 0) {
    return MAX_SUMMARY_PERCENT
  }
  const physical = ((windowTokens - SUMMARY_WINDOW_RESERVE) / windowTokens) * 100
  return Math.max(MIN_SUMMARY_PERCENT, Math.min(MAX_SUMMARY_PERCENT, Math.floor(physical)))
}

/**
 * 输入：用户输入的 token 文本（支持 `200k` / `1m` / `200000`）+ 范围。
 * 输出：token 数；非法或越界返回 undefined。
 * 预期：大小写不敏感，允许小数（如 `1.5m`）。
 */
export function parseTokenCount(text: string, min: number, max: number): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(text.trim())
  if (match === null) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return undefined
  const unit = match[2]?.toLowerCase()
  const multiplier = unit === "k" ? 1_000 : unit === "m" ? 1_000_000 : 1
  const tokens = Math.round(value * multiplier)
  if (tokens < min || tokens > max) return undefined
  return tokens
}

/** 输入：用户输入的上下文上限文本；输出：token 数；非法或越界返回 undefined。 */
export function parseTokenLimit(text: string): number | undefined {
  return parseTokenCount(text, MIN_CONTEXT_LIMIT, MAX_CONTEXT_LIMIT)
}

/** 输入：任意输入文本；输出：只保留数字 + 结尾单个 k/m 的合法形态。 */
export function sanitizeLimitInput(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^0-9km]/g, "")
  const match = /^(\d*)([km]?)/.exec(cleaned)
  return `${match?.[1] ?? ""}${match?.[2] ?? ""}`
}

/** 输入：任意值；输出：是否是合法上下文上限。 */
export function isContextLimit(value: unknown): value is ContextLimit {
  if (value === "auto") return true
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_CONTEXT_LIMIT &&
    value <= MAX_CONTEXT_LIMIT
  )
}

/** 输入：任意值；输出：合法的上下文上限设置（支持 `200k` 这类字符串）。 */
function readContextLimit(value: unknown): ContextLimit {
  if (isContextLimit(value)) return value
  if (typeof value === "string") return parseTokenLimit(value) ?? DEFAULT_SETTINGS.contextLimit
  return DEFAULT_SETTINGS.contextLimit
}

/**
 * 输入：任意设置对象（可能来自旧版本、缺字段或类型不对）。
 * 输出：补齐后的合法设置。
 * 预期：用于启动时迁移 storage 里的旧数据，绝不抛错；旧的绝对值字段不再读取，统一回到百分比默认。
 */
export function normalizeSettings(value: Readonly<Record<string, unknown>>): Settings {
  const percent = value["triggerPercent"]
  const blockPercent = readSummaryPercent(value["summaryBlockPercent"], DEFAULT_SUMMARY_BLOCK_PERCENT)
  const totalPercent = readSummaryPercent(value["summaryTotalPercent"], DEFAULT_SUMMARY_TOTAL_PERCENT)
  return {
    enabled: typeof value["enabled"] === "boolean" ? value["enabled"] : DEFAULT_SETTINGS.enabled,
    expanded: typeof value["expanded"] === "boolean" ? value["expanded"] : DEFAULT_SETTINGS.expanded,
    locale: isLocaleSetting(value["locale"]) ? value["locale"] : DEFAULT_SETTINGS.locale,
    contextLimit: readContextLimit(value["contextLimit"]),
    triggerPercent:
      typeof percent === "number" && Number.isFinite(percent) && percent >= MIN_TRIGGER_PERCENT && percent <= MAX_TRIGGER_PERCENT
        ? Math.round(percent)
        : DEFAULT_SETTINGS.triggerPercent,
    nudgeGrowthTokens: readNudgeGrowthTokens(value["nudgeGrowthTokens"], DEFAULT_NUDGE_GROWTH_TOKENS),
    summaryBlockPercent: blockPercent,
    summaryTotalPercent: totalPercent,
    summaryLanguage: isSummaryLanguage(value["summaryLanguage"]) ? value["summaryLanguage"] : "auto",
    summaryFormat: isSummaryFormat(value["summaryFormat"]) ? value["summaryFormat"] : DEFAULT_SUMMARY_FORMAT,
    autoCompress: typeof value["autoCompress"] === "boolean" ? value["autoCompress"] : DEFAULT_AUTO_COMPRESS,
    enableCompressTool:
      typeof value["enableCompressTool"] === "boolean" ? value["enableCompressTool"] : DEFAULT_ENABLE_COMPRESS_TOOL,
    enableDecompressTool:
      typeof value["enableDecompressTool"] === "boolean" ? value["enableDecompressTool"] : DEFAULT_ENABLE_DECOMPRESS_TOOL,
    showTimeline: typeof value["showTimeline"] === "boolean" ? value["showTimeline"] : DEFAULT_SHOW_TIMELINE,
    showBlockTokens: typeof value["showBlockTokens"] === "boolean" ? value["showBlockTokens"] : DEFAULT_SHOW_BLOCK_TOKENS,
    cacheExpanded: typeof value["cacheExpanded"] === "boolean" ? value["cacheExpanded"] : DEFAULT_CACHE_EXPANDED,
    showCacheChart: typeof value["showCacheChart"] === "boolean" ? value["showCacheChart"] : DEFAULT_SHOW_CACHE_CHART,
    cacheChartExpanded:
      typeof value["cacheChartExpanded"] === "boolean" ? value["cacheChartExpanded"] : DEFAULT_CACHE_CHART_EXPANDED,
    showCacheLog: typeof value["showCacheLog"] === "boolean" ? value["showCacheLog"] : DEFAULT_SHOW_CACHE_LOG,
    cacheLogExpanded:
      typeof value["cacheLogExpanded"] === "boolean" ? value["cacheLogExpanded"] : DEFAULT_CACHE_LOG_EXPANDED,
    showSummaries: typeof value["showSummaries"] === "boolean" ? value["showSummaries"] : DEFAULT_SHOW_SUMMARIES,
    summariesExpanded:
      typeof value["summariesExpanded"] === "boolean" ? value["summariesExpanded"] : DEFAULT_SUMMARIES_EXPANDED,
    ...(typeof value["expandedBlockId"] === "string" && value["expandedBlockId"].length > 0
      ? { expandedBlockId: value["expandedBlockId"] }
      : {}),
    decompressInlineMax: readInt(
      value["decompressInlineMax"],
      MIN_DECOMPRESS_INLINE_MAX,
      MAX_DECOMPRESS_INLINE_MAX,
      DEFAULT_DECOMPRESS_INLINE_MAX,
    ),
    decompressTempCap: readInt(
      value["decompressTempCap"],
      MIN_DECOMPRESS_TEMP_CAP,
      MAX_DECOMPRESS_TEMP_CAP,
      DEFAULT_DECOMPRESS_TEMP_CAP,
    ),
    decompressShowTokens:
      typeof value["decompressShowTokens"] === "boolean" ? value["decompressShowTokens"] : DEFAULT_DECOMPRESS_SHOW_TOKENS,
  }
}

/**
 * 输入：插件 options 的原始值（可能缺失或类型不对）。
 * 输出：合法的初始设置。
 * 预期：非法值回退默认值，绝不抛错。
 */
export function initialSettings(options: Readonly<Record<string, unknown>>): Settings {
  return normalizeSettings(options)
}

/** 输入：设置对象（可能是热重载前的旧对象，字段缺失）。输出：合法的单条摘要百分比。 */
export function effectiveSummaryBlockPercent(settings: Settings): number {
  return readSummaryPercent(settings.summaryBlockPercent, DEFAULT_SUMMARY_BLOCK_PERCENT)
}

/** 输入：设置对象。输出：合法的全部摘要百分比。 */
export function effectiveSummaryTotalPercent(settings: Settings): number {
  return readSummaryPercent(settings.summaryTotalPercent, DEFAULT_SUMMARY_TOTAL_PERCENT)
}

/** 输入：设置；输出：合法的摘要语言。 */
export function effectiveSummaryLanguage(settings: Settings): SummaryLanguage {
  return isSummaryLanguage(settings.summaryLanguage) ? settings.summaryLanguage : "auto"
}

/** 输入：设置；输出：合法的 decompress 内联上限。 */
export function effectiveDecompressInlineMax(settings: { readonly decompressInlineMax?: unknown }): number {
  return readInt(
    settings.decompressInlineMax,
    MIN_DECOMPRESS_INLINE_MAX,
    MAX_DECOMPRESS_INLINE_MAX,
    DEFAULT_DECOMPRESS_INLINE_MAX,
  )
}

/** 输入：设置；输出：合法的 decompress 临时文件上限。 */
export function effectiveDecompressTempCap(settings: { readonly decompressTempCap?: unknown }): number {
  return readInt(
    settings.decompressTempCap,
    MIN_DECOMPRESS_TEMP_CAP,
    MAX_DECOMPRESS_TEMP_CAP,
    DEFAULT_DECOMPRESS_TEMP_CAP,
  )
}

/** 输入：TUI 设置；输出：发给服务端的压缩设置子集；预期：字段列表只在这里维护。 */
export function serverSettingsPayload(settings: Settings): CompressionSettings {
  return {
    contextLimit: settings.contextLimit,
    triggerPercent: settings.triggerPercent,
    nudgeGrowthTokens: settings.nudgeGrowthTokens,
    summaryBlockPercent: effectiveSummaryBlockPercent(settings),
    summaryTotalPercent: effectiveSummaryTotalPercent(settings),
    summaryLanguage: effectiveSummaryLanguage(settings),
    summaryFormat: settings.summaryFormat,
    autoCompress: settings.autoCompress,
    enableCompressTool: settings.enableCompressTool,
    enableDecompressTool: settings.enableDecompressTool,
    showTimeline: settings.showTimeline,
    showBlockTokens: settings.showBlockTokens,
    decompressInlineMax: effectiveDecompressInlineMax(settings),
    decompressTempCap: effectiveDecompressTempCap(settings),
    decompressShowTokens: settings.decompressShowTokens,
  }
}

/**
 * 输入：设置（结构同 Settings，允许缺字段）+ 已知窗口 token 数。
 * 输出：折算后的字符上限与合并预算。
 * 预期：窗口未知时退回默认绝对值；窗口已知时按百分比折算，并扣除 system/tools/recent 预留。
 */
export function resolveSummaryLimits(
  settings: {
    readonly summaryBlockPercent?: unknown
    readonly summaryTotalPercent?: unknown
  },
  windowTokens: number | undefined,
): { blockChars: number; totalChars: number; budgetTokens: number } {
  const blockPercent = effectiveSummaryBlockPercent(settings as Settings)
  const totalPercent = effectiveSummaryTotalPercent(settings as Settings)
  if (windowTokens === undefined || !Number.isFinite(windowTokens) || windowTokens <= 0) {
    return {
      blockChars: DEFAULT_SUMMARY_BLOCK_CHARS,
      totalChars: DEFAULT_SUMMARY_TOTAL_CHARS,
      budgetTokens: DEFAULT_SUMMARY_TOTAL_CHARS,
    }
  }
  const physical = Math.max(0, Math.floor(windowTokens) - SUMMARY_WINDOW_RESERVE)
  const blockChars = Math.min(physical, Math.max(1, Math.round((windowTokens * blockPercent) / 100)))
  const totalChars = Math.min(physical, Math.max(1, Math.round((windowTokens * totalPercent) / 100)))
  return { blockChars, totalChars, budgetTokens: totalChars }
}

/**
 * 输入：语言设置。
 * 输出：传给 resolveMessages 的 locale。
 * 预期：auto 返回 undefined（交给系统检测），其余原样返回。
 */
export function localeArgument(locale: LocaleSetting): string | undefined {
  return locale === "auto" ? undefined : locale
}

/**
 * 输入：设置 + 模型原生上下文长度。
 * 输出：实际使用的上下文上限；未知时返回 undefined。
 * 预期：数字设置是上限，不能超过模型原生窗口；auto 直接用原生值。
 */
export function effectiveLimit(settings: Settings, native: number): number | undefined {
  const value: unknown = settings.contextLimit
  if (isContextLimit(value) && value !== "auto") {
    return native > 0 ? Math.min(value, native) : value
  }
  return native > 0 ? native : undefined
}
