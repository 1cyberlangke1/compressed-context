import type { Plugin } from "@opencode/plugin"

import {
  DEFAULT_AUTO_COMPRESS,
  DEFAULT_DECOMPRESS_INLINE_MAX,
  DEFAULT_DECOMPRESS_SHOW_TOKENS,
  DEFAULT_DECOMPRESS_TEMP_CAP,
  DEFAULT_DECOMPRESS_TEMP_MAX_AGE_HOURS,
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
  MAX_DECOMPRESS_TEMP_MAX_AGE_HOURS,
  MAX_NUDGE_GROWTH_TOKENS,
  MAX_SUMMARY_PERCENT,
  MAX_TRIGGER_PERCENT,
  MIN_DECOMPRESS_INLINE_MAX,
  MIN_DECOMPRESS_TEMP_CAP,
  MIN_DECOMPRESS_TEMP_MAX_AGE_HOURS,
  MIN_NUDGE_GROWTH_TOKENS,
  MIN_SUMMARY_PERCENT,
  MIN_TRIGGER_PERCENT,
  isSummaryLanguage,
  isSummaryFormat,
  normalizeModelOverrides,
  normalizeSettings,
  pruneModelOverride,
  resolveForModel,
  type CompressionSettings,
  type ModelOverride,
  type Settings,
} from "../shared/settings.ts"
import { resolveConfigFiles } from "../shared/config-paths.ts"
import { readOptionalInt, readStrictBoolean } from "../shared/parse.ts"
import { diffConfig, diffRemovedPaths, nearestExistingConfig, readMergedConfig, removeConfigValues, writeConfigValues } from "./config-file.ts"
import type { ConfigReadResult } from "./config-file.ts"

/** 设置读取缓存有效期；文件改动最迟一秒内可见，保存路径会主动失效。 */
const CONFIG_CACHE_MS = 1000

/** 路径列表 → 缓存条目。 */
const configCache = new Map<string, { readonly at: number; readonly result: ConfigReadResult }>()

/** 输入：配置路径列表；输出：稳定的缓存键。 */
function configCacheKey(paths: readonly string[]): string {
  return paths.join("\n")
}

/**
 * 输入：配置路径列表。
 * 输出：合并后的配置。
 * 预期：1 秒内重复读取复用上一次结果，避免每个模型请求都重新读盘解析。
 */
async function readMergedConfigCached(paths: readonly string[]): Promise<ConfigReadResult> {
  const key = configCacheKey(paths)
  const cached = configCache.get(key)
  if (cached !== undefined && Date.now() - cached.at < CONFIG_CACHE_MS) return cached.result
  const result = await readMergedConfig(paths)
  configCache.set(key, { at: Date.now(), result })
  return result
}

/**
 * 服务端需要的设置：全局字段 + 按模型覆盖。
 * 必须带上 `models`，否则按模型设置只在面板生效、压缩时退回全局值。
 */
export type ServerSettings = CompressionSettings & { readonly models: Record<string, ModelOverride> }

/** 读取/写入插件配置需要的上下文；只用到项目目录。 */
export interface SettingsContext {
  readonly location?: { readonly directory?: string }
}
/** 插件最近一次从模型解析到的原生窗口；TUI 用它把绝对值换算成百分比。 */
export const RESOLVED_WINDOW_KEY = "window:last"

/** 最近一次解析到的「生效窗口」＝ min(settings.contextLimit, 原生窗口)；自动压缩用它折算阈值。 */
export const EFFECTIVE_WINDOW_KEY = "window:effective"

/** 输入：会话 ID；输出：该会话最近一次解析到的原生窗口 key。 */
export function resolvedWindowKey(sessionID: string): string {
  return `window:last:${sessionID}`
}

/** 输入：会话 ID；输出：该会话生效窗口 key。多会话并行时不能共用全局值。 */
export function effectiveWindowKey(sessionID: string): string {
  return `window:effective:${sessionID}`
}

/** 输入：模型标识；输出：该模型原生窗口在 storage 里的 key。 */
export function windowKey(providerID: string, modelID: string): string {
  return `window:${providerID}/${modelID}`
}

/**
 * 输入：插件上下文 + 可选的会话 ID。
 * 输出：缓存里的原生窗口 token 数；都没有时 undefined。
 * 预期：有会话时先按会话模型、再按该会话解析值；最后回退全局最近解析值。
 *       每一级只接受正数。
 */
export async function readStoredWindow(
  ctx: Plugin.Context,
  sessionID?: string,
): Promise<number | undefined> {
  const read = async (key: string): Promise<number | undefined> => {
    const value = await ctx.storage.get(key).catch(() => undefined)
    return typeof value === "number" && value > 0 ? value : undefined
  }
  if (sessionID !== undefined) {
    const model = await ctx.session
      .get({ sessionID })
      .then((session) => session.model)
      .catch(() => undefined)
    if (model !== undefined) {
      const stored = await read(windowKey(model.providerID, model.id))
      if (stored !== undefined) return stored
    }
    const scoped = await read(resolvedWindowKey(sessionID))
    if (scoped !== undefined) return scoped
  }
  return read(RESOLVED_WINDOW_KEY)
}

export const DEFAULT_SERVER_SETTINGS: ServerSettings = {
  models: {},
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
  decompressTempMaxAgeHours: DEFAULT_DECOMPRESS_TEMP_MAX_AGE_HOURS,
  decompressShowTokens: DEFAULT_DECOMPRESS_SHOW_TOKENS,
}

/**
 * 输入：任意值 + 闭区间 + 是否允许 0。
 * 输出：是否落在区间内；为 true 时同时把类型收窄成 number。
 * 预期：先判原始值再决定，不做取整——`200000.4` 仍算越界，保持既有拒绝语义。
 */
function inRange(value: unknown, min: number, max: number, allowZero = false): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) return false
  if (allowZero && value === 0) return true
  return value >= min && value <= max
}

/**
 * 输入：storage 里的原始值。
 * 输出：合法设置；非法返回 undefined。
 * 预期：范围外的值一律拒绝，不静默修正。
 */
export function parseServerSettings(value: unknown): ServerSettings | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const percent = record["triggerPercent"]
  const nudge = record["nudgeGrowthTokens"] ?? DEFAULT_NUDGE_GROWTH_TOKENS
  const blockPercent = record["summaryBlockPercent"] ?? DEFAULT_SUMMARY_BLOCK_PERCENT
  const totalPercent = record["summaryTotalPercent"] ?? DEFAULT_SUMMARY_TOTAL_PERCENT
  const language = record["summaryLanguage"] ?? "auto"
  const summaryFormat = record["summaryFormat"] ?? DEFAULT_SUMMARY_FORMAT
  // 按模型覆盖必须一起带过来，否则服务端永远只看到全局值，TUI 面板上的按模型设置形同虚设。
  const models = normalizeModelOverrides(record["models"])
  if (!inRange(percent, MIN_TRIGGER_PERCENT, MAX_TRIGGER_PERCENT)) return undefined
  if (!inRange(nudge, MIN_NUDGE_GROWTH_TOKENS, MAX_NUDGE_GROWTH_TOKENS, true)) return undefined
  if (!inRange(blockPercent, MIN_SUMMARY_PERCENT, MAX_SUMMARY_PERCENT)) return undefined
  if (!inRange(totalPercent, MIN_SUMMARY_PERCENT, MAX_SUMMARY_PERCENT)) return undefined
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
  const decompressTempMaxAgeHours =
    record["decompressTempMaxAgeHours"] === undefined
      ? DEFAULT_DECOMPRESS_TEMP_MAX_AGE_HOURS
      : readOptionalInt(
          record["decompressTempMaxAgeHours"],
          MIN_DECOMPRESS_TEMP_MAX_AGE_HOURS,
          MAX_DECOMPRESS_TEMP_MAX_AGE_HOURS,
        )
  if (
    decompressInlineMax === undefined ||
    decompressTempCap === undefined ||
    decompressTempMaxAgeHours === undefined
  ) {
    return undefined
  }
  return {
    models,
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
    decompressTempMaxAgeHours,
    decompressShowTokens,
  }
}

/**
 * 输入：插件上下文 + 可选 TUI 传来的层路径。
 * 输出：合并后的完整设置。
 * 预期：默认值 < 全局 < 远项目 < 近项目；坏层跳过，字段缺失按默认值补齐。
 *       结果按路径缓存 1 秒，避免每个模型请求重复读盘；保存后立即失效。
 */
export async function loadSettings(ctx: SettingsContext, layers?: readonly string[]): Promise<Settings> {
  const paths = resolveConfigFiles(ctx.location?.directory ?? process.cwd(), layers)
  const merged = await readMergedConfigCached(paths)
  return normalizeSettings(merged.values)
}

/** 输入：插件上下文 + 可选层路径；输出：服务端压缩设置（非法值回退默认）。 */
export async function loadServerSettings(
  ctx: SettingsContext,
  layers?: readonly string[],
): Promise<ServerSettings> {
  return parseServerSettings(await loadSettings(ctx, layers)) ?? DEFAULT_SERVER_SETTINGS
}

/**
 * 输入：插件上下文 + 完整设置 + 可选层路径。
 * 输出：无；失败抛错，由 RPC 转成 ok:false。
 * 预期：只把变化键写进最近的已存在项目文件；没有项目文件时写全局。
 */
export async function saveSettings(
  ctx: SettingsContext,
  settings: Settings,
  layers?: readonly string[],
): Promise<void> {
  const paths = resolveConfigFiles(ctx.location?.directory ?? process.cwd(), layers)
  const merged = await readMergedConfig(paths)
  const normalized = normalizeSettings({ ...settings })
  // 按模型设置只落「与全局默认不同」的字段；整条都等于继承值时删掉这一条。
  const base = resolveForModel({ ...normalized, models: {} }, undefined)
  const pruned: Record<string, ModelOverride> = {}
  for (const [key, override] of Object.entries(normalized.models)) {
    const kept = pruneModelOverride(override, base)
    if (kept !== undefined) pruned[key] = kept
  }
  const next: Settings = { ...normalized, models: pruned }
  const patch = diffConfig(merged.values, { ...next })
  // 全空的 models 不写：空对象也会被当成一次变化，最后又把键删掉。
  if (patch !== undefined && Object.keys(pruned).length === 0) delete patch["models"]
  const target = await nearestExistingConfig(paths)
  if (target === undefined) throw new Error("no plugin config path")
  if (patch !== undefined) {
    const result = await writeConfigValues(target, patch)
    if (!result.ok) throw new Error(result.error)
  }
  const currentModels = merged.values["models"]
  const removed =
    Object.keys(pruned).length === 0 && currentModels !== undefined
      ? [["models"]]
      : diffRemovedPaths({ models: currentModels ?? {} }, { models: pruned }).map((entry) => entry.path)
  if (removed.length > 0) {
    const result = await removeConfigValues(target, removed)
    if (!result.ok) throw new Error(result.error)
  }
  // 写盘后立刻失效，避免随后的 settingsGet 读到旧缓存。
  configCache.delete(configCacheKey(paths))
  // 旧版本写过全局 contextLimit：保存时顺手删掉，配置里不再留一个不生效的键。
  const legacyKeys: (readonly string[])[] = merged.values["contextLimit"] === undefined ? [] : [["contextLimit"]]
  if (legacyKeys.length > 0) {
    const result = await removeConfigValues(target, legacyKeys)
    if (!result.ok) throw new Error(result.error)
    configCache.delete(configCacheKey(paths))
  }
}
