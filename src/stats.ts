/**
 * 上下文统计的跨进程载体。
 *
 * 服务端插件把估算写进 session metadata，TUI 插件读出来按真实 usage 缩放。
 * 本模块只放纯函数：构造、校验、节流判断、metadata 合并、缩放。
 */

import type { TokenCategories } from "./tokens.ts"

/** metadata 里存放统计的键名，避免和其他插件撞车。 */
export const STATS_KEY = "compressed-context"

export const CATEGORY_KEYS = ["system", "tools", "tool", "text", "summaries", "media"] as const

export type CategoryKey = (typeof CATEGORY_KEYS)[number]

export interface ContextStats extends TokenCategories {
  readonly estimatedTotal: number
  readonly at: number
}

/** 两次写入之间至少要有这么多 token 的变化，避免 durable 事件被刷屏。 */
export const PUBLISH_MIN_DELTA = 2_000

/** 输入：分类估算 + 时间戳；输出：带合计的统计对象。 */
export function createStats(categories: TokenCategories, now: number): ContextStats {
  const estimatedTotal =
    categories.system +
    categories.tools +
    categories.tool +
    categories.text +
    categories.summaries +
    categories.media
  return { ...categories, estimatedTotal, at: now }
}

/** 输入：任意 metadata 值；输出：合法数字或 undefined。 */
function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * 输入：metadata 里的原始 JSON。
 * 输出：校验通过的统计对象；缺字段、类型不对或负数返回 undefined。
 * 预期：metadata 可能被别的版本或别的插件改写，解析必须防御。
 */
export function parseStats(value: unknown): ContextStats | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const system = readNumber(record["system"])
  const tools = readNumber(record["tools"])
  const tool = readNumber(record["tool"])
  const text = readNumber(record["text"])
  const summaries = readNumber(record["summaries"])
  const media = readNumber(record["media"])
  const estimatedTotal = readNumber(record["estimatedTotal"])
  const at = readNumber(record["at"])
  if (
    system === undefined ||
    tools === undefined ||
    tool === undefined ||
    text === undefined ||
    summaries === undefined ||
    media === undefined ||
    estimatedTotal === undefined ||
    at === undefined
  ) {
    return undefined
  }
  return { system, tools, tool, text, summaries, media, estimatedTotal, at }
}

/**
 * 输入：上一次发布的统计（可能没有）+ 本次统计。
 * 输出：是否值得写一次 metadata。
 * 预期：合计或任一分类变化达到阈值才写，减少 durable 事件。
 */
export function shouldPublish(previous: ContextStats | undefined, next: ContextStats): boolean {
  if (previous === undefined) return true
  if (Math.abs(next.estimatedTotal - previous.estimatedTotal) >= PUBLISH_MIN_DELTA) return true
  return CATEGORY_KEYS.some((key) => Math.abs(next[key] - previous[key]) >= PUBLISH_MIN_DELTA)
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/**
 * 输入：已有 metadata + 本次统计。
 * 输出：保留其他键、替换 STATS_KEY 的新对象。
 * 预期：metadata 是整体替换语义，必须先合并再写。
 */
export function mergeMetadata(
  metadata: Readonly<Record<string, JsonValue>> | undefined,
  stats: ContextStats,
): Record<string, JsonValue> {
  return {
    ...(metadata ?? {}),
    [STATS_KEY]: {
      system: stats.system,
      tools: stats.tools,
      tool: stats.tool,
      text: stats.text,
      summaries: stats.summaries,
      media: stats.media,
      estimatedTotal: stats.estimatedTotal,
      at: stats.at,
    },
  }
}

export interface ScaledCategory {
  readonly key: CategoryKey
  readonly value: number
  readonly pct: number
}

/**
 * 输入：估算统计 + 真实总量（0 表示上游没给）。
 * 输出：按真实总量缩放后的各类数值与百分比。
 * 预期：真实总量缺失时按原值展示；百分比分母是缩放后的合计。
 */
export function scaleCategories(stats: ContextStats, realTotal: number): readonly ScaledCategory[] {
  const scale = realTotal > 0 && stats.estimatedTotal > 0 ? realTotal / stats.estimatedTotal : 1
  const scaled = CATEGORY_KEYS.map((key) => ({ key, value: Math.round(stats[key] * scale) }))
  const total = scaled.reduce((sum, item) => sum + item.value, 0)
  return scaled.map((item) => ({
    key: item.key,
    value: item.value,
    pct: total > 0 ? Math.round((item.value / total) * 100) : 0,
  }))
}
