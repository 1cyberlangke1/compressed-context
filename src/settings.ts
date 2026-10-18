/**
 * TUI 面板设置。
 *
 * 存在 TUI 自己的 storage 里（`context.storage.store`），用户不用改 config.json。
 * 优先级：UI 改过的值 > 插件 options 给的初始值 > 内置默认。
 */

export const LOCALE_SETTINGS = ["auto", "zh", "en"] as const

export type LocaleSetting = (typeof LOCALE_SETTINGS)[number]

/** 上下文窗口上限：auto 复用模型原生值，数字表示自定义 token 数。 */
export type ContextLimit = "auto" | number

export interface Settings {
  /** 是否显示整块上下文面板 */
  enabled: boolean
  /** 面板是否展开（折叠后只剩标题行） */
  expanded: boolean
  /** 界面语言；auto 跟随系统 */
  locale: LocaleSetting
  /** 上下文窗口上限 */
  contextLimit: ContextLimit
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  expanded: true,
  locale: "auto",
  contextLimit: "auto",
}

/** 自定义上限允许的范围。 */
export const MIN_CONTEXT_LIMIT = 1_000
export const MAX_CONTEXT_LIMIT = 10_000_000

/** 输入：任意值；输出：是否是合法语言设置。 */
export function isLocaleSetting(value: unknown): value is LocaleSetting {
  return typeof value === "string" && (LOCALE_SETTINGS as readonly string[]).includes(value)
}

/**
 * 输入：用户输入的 token 上限文本（支持 `200k` / `1m` / `200000`）。
 * 输出：token 数；非法或越界返回 undefined。
 * 预期：大小写不敏感，允许小数（如 `1.5m`）。
 */
export function parseTokenLimit(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(text.trim())
  if (match === null) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return undefined
  const unit = match[2]?.toLowerCase()
  const multiplier = unit === "k" ? 1_000 : unit === "m" ? 1_000_000 : 1
  const tokens = Math.round(value * multiplier)
  if (tokens < MIN_CONTEXT_LIMIT || tokens > MAX_CONTEXT_LIMIT) return undefined
  return tokens
}

/** 输入：任意值；输出：合法的上下文上限设置。 */
function readContextLimit(value: unknown): ContextLimit {
  if (value === "auto") return "auto"
  if (typeof value === "number" && Number.isFinite(value)) {
    const rounded = Math.round(value)
    return rounded >= MIN_CONTEXT_LIMIT && rounded <= MAX_CONTEXT_LIMIT ? rounded : "auto"
  }
  if (typeof value === "string") return parseTokenLimit(value) ?? "auto"
  return "auto"
}

/**
 * 输入：插件 options 的原始值（可能缺失或类型不对）。
 * 输出：合法的初始设置。
 * 预期：非法值回退默认值，绝不抛错。
 */
export function initialSettings(options: Readonly<Record<string, unknown>>): Settings {
  return {
    enabled: typeof options["enabled"] === "boolean" ? options["enabled"] : DEFAULT_SETTINGS.enabled,
    expanded: typeof options["expanded"] === "boolean" ? options["expanded"] : DEFAULT_SETTINGS.expanded,
    locale: isLocaleSetting(options["locale"]) ? options["locale"] : DEFAULT_SETTINGS.locale,
    contextLimit: readContextLimit(options["contextLimit"]),
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
  if (settings.contextLimit !== "auto") return settings.contextLimit
  return native > 0 ? native : undefined
}
