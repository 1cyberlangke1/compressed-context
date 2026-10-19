import type { Schema } from "effect"

import {
  DEFAULT_SUMMARY_BLOCK_CHARS,
  DEFAULT_SUMMARY_TOTAL_CHARS,
  MAX_SUMMARY_BLOCK_CHARS,
  MAX_SUMMARY_TOTAL_CHARS,
  MIN_SUMMARY_BLOCK_CHARS,
  MIN_SUMMARY_TOTAL_CHARS,
  SUMMARY_WINDOW_RESERVE,
  isSummaryLanguage,
  type SummaryLanguage,
} from "../settings.ts"
import type { StorageLike } from "./state.ts"

/** 服务端从 TUI 收到的设置。 */
export interface ServerSettings {
  readonly contextLimit: "auto" | number
  readonly triggerPercent: number
  readonly summaryBudgetTokens: number
  readonly summaryBlockChars: number
  readonly summaryTotalChars: number
  readonly summaryLanguage: SummaryLanguage
}

export const SETTINGS_KEY = "settings"
export const MIN_TRIGGER_PERCENT = 60
export const MAX_TRIGGER_PERCENT = 95
export const MIN_CONTEXT_LIMIT = 1_000
export const MAX_CONTEXT_LIMIT = 10_000_000
export const MIN_SUMMARY_BUDGET = 5_000
export const MAX_SUMMARY_BUDGET = 1_000_000
export const DEFAULT_SUMMARY_BUDGET = 50_000

export const DEFAULT_SERVER_SETTINGS: ServerSettings = {
  contextLimit: "auto",
  triggerPercent: 80,
  summaryBudgetTokens: DEFAULT_SUMMARY_BUDGET,
  summaryBlockChars: DEFAULT_SUMMARY_BLOCK_CHARS,
  summaryTotalChars: DEFAULT_SUMMARY_TOTAL_CHARS,
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
  const budget = record["summaryBudgetTokens"] ?? DEFAULT_SUMMARY_BUDGET
  const blockChars = record["summaryBlockChars"] ?? DEFAULT_SUMMARY_BLOCK_CHARS
  const totalChars = record["summaryTotalChars"] ?? DEFAULT_SUMMARY_TOTAL_CHARS
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
    typeof budget !== "number" ||
    !Number.isFinite(budget) ||
    budget < MIN_SUMMARY_BUDGET ||
    budget > MAX_SUMMARY_BUDGET
  ) {
    return undefined
  }
  if (
    typeof blockChars !== "number" ||
    !Number.isFinite(blockChars) ||
    blockChars < MIN_SUMMARY_BLOCK_CHARS ||
    blockChars > MAX_SUMMARY_BLOCK_CHARS
  ) {
    return undefined
  }
  if (
    typeof totalChars !== "number" ||
    !Number.isFinite(totalChars) ||
    totalChars < MIN_SUMMARY_TOTAL_CHARS ||
    totalChars > MAX_SUMMARY_TOTAL_CHARS ||
    totalChars < blockChars
  ) {
    return undefined
  }
  if (!isSummaryLanguage(language)) return undefined
  // 数字窗口下，用户显式设置的摘要上限按 1 字符 ≈ 1 token 的最坏情况，不得超过窗口减预留；
  // 窗口小到装不下最小摘要（或字段缺省回退默认值）时不校验——运行时钳制兜底，失败原因交给校验。
  if (typeof limit === "number") {
    const ceiling = limit - SUMMARY_WINDOW_RESERVE
    if (ceiling >= MIN_SUMMARY_BLOCK_CHARS) {
      const hasBlock = record["summaryBlockChars"] !== undefined
      const hasTotal = record["summaryTotalChars"] !== undefined
      if ((hasBlock && Math.round(blockChars) > ceiling) || (hasTotal && Math.round(totalChars) > ceiling)) {
        return undefined
      }
    }
  }
  return {
    contextLimit: limit,
    triggerPercent: Math.round(percent),
    summaryBudgetTokens: Math.round(budget),
    summaryBlockChars: Math.round(blockChars),
    summaryTotalChars: Math.round(totalChars),
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
