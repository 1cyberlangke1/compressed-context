import type { Schema } from "effect"

import type { StorageLike } from "./state.ts"

/** 服务端从 TUI 收到的设置。 */
export interface ServerSettings {
  readonly contextLimit: "auto" | number
  readonly triggerPercent: number
}

export const SETTINGS_KEY = "settings"
export const MIN_TRIGGER_PERCENT = 60
export const MAX_TRIGGER_PERCENT = 95
export const MIN_CONTEXT_LIMIT = 1_000
export const MAX_CONTEXT_LIMIT = 10_000_000

export const DEFAULT_SERVER_SETTINGS: ServerSettings = {
  contextLimit: "auto",
  triggerPercent: 80,
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
  return { contextLimit: limit, triggerPercent: Math.round(percent) }
}

/** 输入：storage；输出：设置（缺失或损坏时用默认值）。 */
export async function loadServerSettings(storage: StorageLike): Promise<ServerSettings> {
  return parseServerSettings(await storage.get(SETTINGS_KEY)) ?? DEFAULT_SERVER_SETTINGS
}

/** 输入：storage + 设置；输出：无。 */
export async function saveServerSettings(storage: StorageLike, settings: ServerSettings): Promise<void> {
  await storage.set(SETTINGS_KEY, settings as unknown as Schema.Json)
}
