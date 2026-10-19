/**
 * TUI 面板设置。
 *
 * 存在 TUI 自己的 storage 里（`context.storage.store`），用户不用改 config.json。
 * 优先级：UI 改过的值 > 插件 options 给的初始值 > 内置默认。
 */

export const LOCALE_SETTINGS = ["auto", "zh", "en"] as const

export type LocaleSetting = (typeof LOCALE_SETTINGS)[number]

/** 摘要语言；auto 跟随源对话。 */
export const SUMMARY_LANGUAGES = ["auto", "zh", "en"] as const

export type SummaryLanguage = (typeof SUMMARY_LANGUAGES)[number]

export const MIN_SUMMARY_BLOCK_CHARS = 500
export const MAX_SUMMARY_BLOCK_CHARS = 100_000
export const DEFAULT_SUMMARY_BLOCK_CHARS = 20_000

export const MIN_SUMMARY_TOTAL_CHARS = 5_000
export const MAX_SUMMARY_TOTAL_CHARS = 1_000_000
export const DEFAULT_SUMMARY_TOTAL_CHARS = 100_000

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

/** 摘要链预算：超过后自动合并摘要块。 */
export const MIN_SUMMARY_BUDGET = 5_000
export const MAX_SUMMARY_BUDGET = 1_000_000
export const DEFAULT_SUMMARY_BUDGET = 50_000

export interface Settings {
  /** 是否显示整块上下文面板 */
  enabled: boolean
  /** 面板是否展开（折叠后只剩标题行） */
  expanded: boolean
  /** 界面语言；auto 跟随系统 */
  locale: LocaleSetting
  /** 上下文窗口上限 */
  contextLimit: ContextLimit
  /** 强制压缩阈值（占用百分比） */
  triggerPercent: number
  /** 摘要链 token 预算 */
  summaryBudgetTokens: number
  /** 单条摘要字符上限 */
  summaryBlockChars: number
  /** 全部摘要字符上限 */
  summaryTotalChars: number
  /** 摘要语言；只影响提示词 */
  summaryLanguage: SummaryLanguage
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  expanded: true,
  locale: "auto",
  contextLimit: "auto",
  triggerPercent: DEFAULT_TRIGGER_PERCENT,
  summaryBudgetTokens: DEFAULT_SUMMARY_BUDGET,
  summaryBlockChars: DEFAULT_SUMMARY_BLOCK_CHARS,
  summaryTotalChars: DEFAULT_SUMMARY_TOTAL_CHARS,
  summaryLanguage: "auto",
}

/** 自定义上限允许的范围。 */
export const MIN_CONTEXT_LIMIT = 1_000
export const MAX_CONTEXT_LIMIT = 10_000_000

/** 输入：任意值；输出：是否是合法语言设置。 */
export function isLocaleSetting(value: unknown): value is LocaleSetting {
  return typeof value === "string" && (LOCALE_SETTINGS as readonly string[]).includes(value)
}

/** 输入：任意值；输出：是否是合法摘要语言。 */
export function isSummaryLanguage(value: unknown): value is SummaryLanguage {
  return typeof value === "string" && (SUMMARY_LANGUAGES as readonly string[]).includes(value)
}

/** 输入：任意值 + 范围；输出：合法的字符上限。 */
function readCharLimit(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max) {
    return Math.round(value)
  }
  if (typeof value === "string") return parseTokenCount(value, min, max) ?? fallback
  return fallback
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

/** 输入：任意值；输出：合法的摘要预算设置（支持 `50k` 这类字符串）。 */
function readSummaryBudget(value: unknown): number {
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_SUMMARY_BUDGET &&
    value <= MAX_SUMMARY_BUDGET
  ) {
    return Math.round(value)
  }
  if (typeof value === "string") {
    return parseTokenCount(value, MIN_SUMMARY_BUDGET, MAX_SUMMARY_BUDGET) ?? DEFAULT_SUMMARY_BUDGET
  }
  return DEFAULT_SUMMARY_BUDGET
}

/**
 * 输入：任意设置对象（可能来自旧版本、缺字段或类型不对）。
 * 输出：补齐后的合法设置。
 * 预期：用于启动时迁移 storage 里的旧数据，绝不抛错。
 */
export function normalizeSettings(value: Readonly<Record<string, unknown>>): Settings {
  const percent = value["triggerPercent"]
  const blockChars = readCharLimit(
    value["summaryBlockChars"],
    MIN_SUMMARY_BLOCK_CHARS,
    MAX_SUMMARY_BLOCK_CHARS,
    DEFAULT_SUMMARY_BLOCK_CHARS,
  )
  const totalChars = Math.max(
    blockChars,
    readCharLimit(
      value["summaryTotalChars"],
      MIN_SUMMARY_TOTAL_CHARS,
      MAX_SUMMARY_TOTAL_CHARS,
      DEFAULT_SUMMARY_TOTAL_CHARS,
    ),
  )
  return {
    enabled: typeof value["enabled"] === "boolean" ? value["enabled"] : DEFAULT_SETTINGS.enabled,
    expanded: typeof value["expanded"] === "boolean" ? value["expanded"] : DEFAULT_SETTINGS.expanded,
    locale: isLocaleSetting(value["locale"]) ? value["locale"] : DEFAULT_SETTINGS.locale,
    contextLimit: readContextLimit(value["contextLimit"]),
    triggerPercent:
      typeof percent === "number" && Number.isFinite(percent) && percent >= MIN_TRIGGER_PERCENT && percent <= MAX_TRIGGER_PERCENT
        ? Math.round(percent)
        : DEFAULT_SETTINGS.triggerPercent,
    summaryBudgetTokens: readSummaryBudget(value["summaryBudgetTokens"]),
    summaryBlockChars: blockChars,
    summaryTotalChars: totalChars,
    summaryLanguage: isSummaryLanguage(value["summaryLanguage"]) ? value["summaryLanguage"] : "auto",
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

/**
 * 输入：设置对象（可能是热重载前的旧对象，字段缺失）。
 * 输出：合法的摘要预算；缺失或非法时回退默认值。
 * 预期：运行时兜底，避免旧 settings 直接 .toString() 崩溃。
 */
export function effectiveSummaryBudget(settings: Settings): number {
  const value: unknown = settings.summaryBudgetTokens
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_SUMMARY_BUDGET &&
    value <= MAX_SUMMARY_BUDGET
  ) {
    return Math.round(value)
  }
  return DEFAULT_SUMMARY_BUDGET
}

/** 输入：设置；输出：合法的单条摘要字符上限。 */
export function effectiveSummaryBlockChars(settings: Settings): number {
  const value: unknown = settings.summaryBlockChars
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_SUMMARY_BLOCK_CHARS &&
    value <= MAX_SUMMARY_BLOCK_CHARS
  ) {
    return Math.round(value)
  }
  return DEFAULT_SUMMARY_BLOCK_CHARS
}

/** 输入：设置；输出：合法的摘要总字符上限，保证不小于单条上限。 */
export function effectiveSummaryTotalChars(settings: Settings): number {
  const block = effectiveSummaryBlockChars(settings)
  const value: unknown = settings.summaryTotalChars
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_SUMMARY_TOTAL_CHARS &&
    value <= MAX_SUMMARY_TOTAL_CHARS
  ) {
    return Math.max(block, Math.round(value))
  }
  return Math.max(block, DEFAULT_SUMMARY_TOTAL_CHARS)
}

/** 输入：设置；输出：合法的摘要语言。 */
export function effectiveSummaryLanguage(settings: Settings): SummaryLanguage {
  return isSummaryLanguage(settings.summaryLanguage) ? settings.summaryLanguage : "auto"
}

/**
 * 输入：设置（结构同 Settings，允许缺字段）+ 已知窗口 token 数（auto 未解析时为 undefined）。
 * 输出：钳制后的 blockChars / totalChars / budgetTokens。
 * 预期：窗口未知时原样返回；窗口已知时任何一项都不得超过 窗口 − 预留。
 */
export function clampSummaryLimits(
  settings: {
    readonly summaryBlockChars?: unknown
    readonly summaryTotalChars?: unknown
    readonly summaryBudgetTokens?: unknown
  },
  windowTokens: number | undefined,
): { blockChars: number; totalChars: number; budgetTokens: number } {
  const blockChars = effectiveSummaryBlockChars(settings as Settings)
  const totalChars = Math.max(blockChars, effectiveSummaryTotalChars(settings as Settings))
  const budgetTokens = effectiveSummaryBudget(settings as Settings)
  if (windowTokens === undefined || !Number.isFinite(windowTokens) || windowTokens <= 0) {
    return { blockChars, totalChars, budgetTokens }
  }
  const ceiling = Math.max(0, Math.floor(windowTokens) - SUMMARY_WINDOW_RESERVE)
  if (ceiling < 500) {
    // 窗口小到装不下最小摘要时钳制只会把上限压成 0，让压缩必然失败；保持用户值，失败原因交给校验。
    return { blockChars, totalChars, budgetTokens }
  }
  return {
    blockChars: Math.min(blockChars, ceiling),
    totalChars: Math.min(totalChars, ceiling),
    budgetTokens: Math.min(budgetTokens, ceiling),
  }
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
 * 预期：自定义值优先；auto 时回退模型原生值。
 */
export function effectiveLimit(settings: Settings, native: number): number | undefined {
  const value: unknown = settings.contextLimit
  if (isContextLimit(value) && value !== "auto") return value
  return native > 0 ? native : undefined
}
