import type { Schema } from "effect"

import {
  DEFAULT_AUTO_COMPRESS,
  DEFAULT_DECOMPRESS_INLINE_MAX,
  DEFAULT_DECOMPRESS_SHOW_TOKENS,
  DEFAULT_DECOMPRESS_TEMP_CAP,
  DEFAULT_ENABLE_COMPRESS_TOOL,
  DEFAULT_ENABLE_DECOMPRESS_TOOL,
  DEFAULT_NUDGE_GROWTH_TOKENS,
  DEFAULT_SHOW_BLOCK_TOKENS,
  DEFAULT_SHOW_TIMELINE,
  DEFAULT_SUMMARY_BLOCK_PERCENT,
  DEFAULT_SUMMARY_FORMAT,
  DEFAULT_SUMMARY_TOTAL_PERCENT,
  MAX_DECOMPRESS_INLINE_MAX,
  MAX_DECOMPRESS_TEMP_CAP,
  MAX_CONTEXT_LIMIT,
  MAX_SUMMARY_PERCENT,
  MAX_TRIGGER_PERCENT,
  MIN_CONTEXT_LIMIT,
  MIN_DECOMPRESS_INLINE_MAX,
  MIN_DECOMPRESS_TEMP_CAP,
  MIN_SUMMARY_PERCENT,
  MIN_TRIGGER_PERCENT,
  isSummaryLanguage,
  isSummaryFormat,
  type CompressionSettings,
} from "../shared/settings.ts"
import { readOptionalInt, readStrictBoolean } from "../shared/parse.ts"
import type { StorageLike } from "./state.ts"

/** 服务端从 TUI 收到的设置；字段与 shared 的 CompressionSettings 一致。 */
export type ServerSettings = CompressionSettings

export const SETTINGS_KEY = "settings"
/** 插件最近一次从模型解析到的原生窗口；TUI 用它把绝对值换算成百分比。 */
export const RESOLVED_WINDOW_KEY = "window:last"

/** 最近一次解析到的「生效窗口」＝ min(settings.contextLimit, 原生窗口)；自动压缩用它折算阈值。 */
export const EFFECTIVE_WINDOW_KEY = "window:effective"

/** 输入：模型标识；输出：该模型原生窗口在 storage 里的 key。 */
export function windowKey(providerID: string, modelID: string): string {
  return `window:${providerID}/${modelID}`
}

export const DEFAULT_SERVER_SETTINGS: ServerSettings = {
  contextLimit: "auto",
  triggerPercent: 80,
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
  decompressInlineMax: DEFAULT_DECOMPRESS_INLINE_MAX,
  decompressTempCap: DEFAULT_DECOMPRESS_TEMP_CAP,
  decompressShowTokens: DEFAULT_DECOMPRESS_SHOW_TOKENS,
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
  const nudge = record["nudgeGrowthTokens"] ?? DEFAULT_NUDGE_GROWTH_TOKENS
  const blockPercent = record["summaryBlockPercent"] ?? DEFAULT_SUMMARY_BLOCK_PERCENT
  const totalPercent = record["summaryTotalPercent"] ?? DEFAULT_SUMMARY_TOTAL_PERCENT
  const language = record["summaryLanguage"] ?? "auto"
  const summaryFormat = record["summaryFormat"] ?? DEFAULT_SUMMARY_FORMAT
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
    typeof nudge !== "number" ||
    !Number.isFinite(nudge) ||
    (nudge !== 0 && (nudge < 1_000 || nudge > 200_000))
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
  if (!isSummaryFormat(summaryFormat)) return undefined
  const autoCompress = readStrictBoolean(record["autoCompress"], DEFAULT_AUTO_COMPRESS)
  const enableCompressTool = readStrictBoolean(record["enableCompressTool"], DEFAULT_ENABLE_COMPRESS_TOOL)
  const enableDecompressTool = readStrictBoolean(record["enableDecompressTool"], DEFAULT_ENABLE_DECOMPRESS_TOOL)
  const showTimeline = readStrictBoolean(record["showTimeline"], DEFAULT_SHOW_TIMELINE)
  const showBlockTokens = readStrictBoolean(record["showBlockTokens"], DEFAULT_SHOW_BLOCK_TOKENS)
  const decompressShowTokens = readStrictBoolean(record["decompressShowTokens"], DEFAULT_DECOMPRESS_SHOW_TOKENS)
  if (
    autoCompress === undefined ||
    enableCompressTool === undefined ||
    enableDecompressTool === undefined ||
    showTimeline === undefined ||
    showBlockTokens === undefined ||
    decompressShowTokens === undefined
  ) {
    return undefined
  }
  const decompressInlineMax =
    record["decompressInlineMax"] === undefined
      ? DEFAULT_DECOMPRESS_INLINE_MAX
      : readOptionalInt(record["decompressInlineMax"], MIN_DECOMPRESS_INLINE_MAX, MAX_DECOMPRESS_INLINE_MAX)
  const decompressTempCap =
    record["decompressTempCap"] === undefined
      ? DEFAULT_DECOMPRESS_TEMP_CAP
      : readOptionalInt(record["decompressTempCap"], MIN_DECOMPRESS_TEMP_CAP, MAX_DECOMPRESS_TEMP_CAP)
  if (decompressInlineMax === undefined || decompressTempCap === undefined) return undefined
  return {
    contextLimit: limit,
    triggerPercent: Math.round(percent),
    nudgeGrowthTokens: Math.round(nudge),
    summaryBlockPercent: Math.round(blockPercent * 10) / 10,
    summaryTotalPercent: Math.round(totalPercent * 10) / 10,
    summaryLanguage: language,
    summaryFormat,
    autoCompress,
    enableCompressTool,
    enableDecompressTool,
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
