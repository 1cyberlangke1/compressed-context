import type { Schema } from "effect"

import {
  DEFAULT_SUMMARY_BLOCK_PERCENT,
  DEFAULT_SUMMARY_TOTAL_PERCENT,
  MAX_SUMMARY_PERCENT,
  MIN_CONTEXT_LIMIT,
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
  return {
    contextLimit: limit,
    triggerPercent: Math.round(percent),
    summaryBlockPercent: Math.round(blockPercent * 10) / 10,
    summaryTotalPercent: Math.round(totalPercent * 10) / 10,
    summaryLanguage: language,
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
