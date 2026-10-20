import type { Schema } from "effect"

import {
  DEFAULT_AUTO_COMPRESS,
  DEFAULT_DECOMPRESS_INLINE_MAX,
  DEFAULT_DECOMPRESS_SHOW_TOKENS,
  DEFAULT_DECOMPRESS_TEMP_CAP,
  DEFAULT_SHOW_BLOCK_TOKENS,
  DEFAULT_SHOW_TIMELINE,
  DEFAULT_SUMMARY_BLOCK_PERCENT,
  DEFAULT_SUMMARY_TOTAL_PERCENT,
  MAX_DECOMPRESS_INLINE_MAX,
  MAX_DECOMPRESS_TEMP_CAP,
  MAX_SUMMARY_PERCENT,
  MIN_CONTEXT_LIMIT,
  MIN_DECOMPRESS_INLINE_MAX,
  MIN_DECOMPRESS_TEMP_CAP,
  MIN_SUMMARY_PERCENT,
  isSummaryLanguage,
  type SummaryLanguage,
} from "../settings.ts"
import type { StorageLike } from "./state.ts"

/** 服务端从 TUI 收到的设置。 */
export interface ServerSettings {
  readonly contextLimit: "auto" | number
  readonly triggerPercent: number
  readonly summaryBlockPercent: number
  readonly summaryTotalPercent: number
  readonly summaryLanguage: SummaryLanguage
  readonly autoCompress: boolean
  readonly showTimeline: boolean
  readonly showBlockTokens: boolean
  readonly decompressInlineMax: number
  readonly decompressTempCap: number
  readonly decompressShowTokens: boolean
}

export const SETTINGS_KEY = "settings"
/** 插件最近一次从模型解析到的原生窗口；TUI 用它把绝对值换算成百分比。 */
export const RESOLVED_WINDOW_KEY = "window:last"
export const MIN_TRIGGER_PERCENT = 60
export const MAX_TRIGGER_PERCENT = 95
export const MAX_CONTEXT_LIMIT = 10_000_000

export const DEFAULT_SERVER_SETTINGS: ServerSettings = {
  contextLimit: "auto",
  triggerPercent: 80,
  summaryBlockPercent: DEFAULT_SUMMARY_BLOCK_PERCENT,
  summaryTotalPercent: DEFAULT_SUMMARY_TOTAL_PERCENT,
  summaryLanguage: "auto",
  autoCompress: DEFAULT_AUTO_COMPRESS,
  showTimeline: DEFAULT_SHOW_TIMELINE,
  showBlockTokens: DEFAULT_SHOW_BLOCK_TOKENS,
  decompressInlineMax: DEFAULT_DECOMPRESS_INLINE_MAX,
  decompressTempCap: DEFAULT_DECOMPRESS_TEMP_CAP,
  decompressShowTokens: DEFAULT_DECOMPRESS_SHOW_TOKENS,
}

/** 输入：任意值 + 范围；输出：合法整数；非法返回 undefined。 */
function readInt(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  const rounded = Math.round(value)
  if (rounded < min || rounded > max) return undefined
  return rounded
}

/** 输入：任意值；输出：布尔值；缺省返回 fallback，类型不对返回 undefined。 */
function readBoolean(value: unknown, fallback: boolean): boolean | undefined {
  if (value === undefined) return fallback
  return typeof value === "boolean" ? value : undefined
}

/**
 * 输入：storage 里的原始值。
 * 输出：合法设置；非法返回 undefined。
 * 预期：范围外的值一律拒绝，不静默修正。
 */
export function parseServerSettings(value: unknown): ServerSettings | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const limit = record["contextLimit"]
  const percent = record["triggerPercent"]
  const blockPercent = record["summaryBlockPercent"] ?? DEFAULT_SUMMARY_BLOCK_PERCENT
  const totalPercent = record["summaryTotalPercent"] ?? DEFAULT_SUMMARY_TOTAL_PERCENT
  const language = record["summaryLanguage"] ?? "auto"
  if (
    limit !== "auto" &&
    (typeof limit !== "number" ||
      !Number.isFinite(limit) ||
      limit < MIN_CONTEXT_LIMIT ||
      limit > MAX_CONTEXT_LIMIT)
  ) {
    return undefined
  }
  if (
    typeof percent !== "number" ||
    !Number.isFinite(percent) ||
    percent < MIN_TRIGGER_PERCENT ||
    percent > MAX_TRIGGER_PERCENT
  ) {
    return undefined
  }
  if (
    typeof blockPercent !== "number" ||
    !Number.isFinite(blockPercent) ||
    blockPercent < MIN_SUMMARY_PERCENT ||
    blockPercent > MAX_SUMMARY_PERCENT
  ) {
    return undefined
  }
  if (
    typeof totalPercent !== "number" ||
    !Number.isFinite(totalPercent) ||
    totalPercent < MIN_SUMMARY_PERCENT ||
    totalPercent > MAX_SUMMARY_PERCENT
  ) {
    return undefined
  }
  if (!isSummaryLanguage(language)) return undefined
  const autoCompress = readBoolean(record["autoCompress"], DEFAULT_AUTO_COMPRESS)
  const showTimeline = readBoolean(record["showTimeline"], DEFAULT_SHOW_TIMELINE)
  const showBlockTokens = readBoolean(record["showBlockTokens"], DEFAULT_SHOW_BLOCK_TOKENS)
  const decompressShowTokens = readBoolean(record["decompressShowTokens"], DEFAULT_DECOMPRESS_SHOW_TOKENS)
  if (
    autoCompress === undefined ||
    showTimeline === undefined ||
    showBlockTokens === undefined ||
    decompressShowTokens === undefined
  ) {
    return undefined
  }
  const decompressInlineMax =
    record["decompressInlineMax"] === undefined
      ? DEFAULT_DECOMPRESS_INLINE_MAX
      : readInt(record["decompressInlineMax"], MIN_DECOMPRESS_INLINE_MAX, MAX_DECOMPRESS_INLINE_MAX)
  const decompressTempCap =
    record["decompressTempCap"] === undefined
      ? DEFAULT_DECOMPRESS_TEMP_CAP
      : readInt(record["decompressTempCap"], MIN_DECOMPRESS_TEMP_CAP, MAX_DECOMPRESS_TEMP_CAP)
  if (decompressInlineMax === undefined || decompressTempCap === undefined) return undefined
  return {
    contextLimit: limit,
    triggerPercent: Math.round(percent),
    summaryBlockPercent: Math.round(blockPercent * 10) / 10,
    summaryTotalPercent: Math.round(totalPercent * 10) / 10,
    summaryLanguage: language,
    autoCompress,
    showTimeline,
    showBlockTokens,
    decompressInlineMax,
    decompressTempCap,
    decompressShowTokens,
  }
}

/** 输入：storage；输出：设置（缺失或损坏时用默认值）。 */
export async function loadServerSettings(storage: StorageLike): Promise<ServerSettings> {
  return parseServerSettings(await storage.get(SETTINGS_KEY)) ?? DEFAULT_SERVER_SETTINGS
}

/** 输入：storage + 设置；输出：无。 */
export async function saveServerSettings(storage: StorageLike, settings: ServerSettings): Promise<void> {
  await storage.set(SETTINGS_KEY, settings as unknown as Schema.Json)
}
