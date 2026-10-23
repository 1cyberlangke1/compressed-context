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
  MAX_CONTEXT_LIMIT,
  MAX_SUMMARY_PERCENT,
  MAX_TRIGGER_PERCENT,
  MIN_CONTEXT_LIMIT,
  MIN_DECOMPRESS_INLINE_MAX,
  MIN_DECOMPRESS_TEMP_CAP,
  MIN_DECOMPRESS_TEMP_MAX_AGE_HOURS,
  MIN_SUMMARY_PERCENT,
  MIN_TRIGGER_PERCENT,
  isSummaryLanguage,
  isSummaryFormat,
  normalizeSettings,
  type CompressionSettings,
  type Settings,
} from "../shared/settings.ts"
import { resolveConfigFiles } from "../shared/config-paths.ts"
import { readOptionalInt, readStrictBoolean } from "../shared/parse.ts"
import { diffConfig, nearestExistingConfig, readMergedConfig, writeConfigValues } from "./config-file.ts"

/** 服务端从 TUI 收到的设置；字段与 shared 的 CompressionSettings 一致。 */
export type ServerSettings = CompressionSettings

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
  decompressTempMaxAgeHours: DEFAULT_DECOMPRESS_TEMP_MAX_AGE_HOURS,
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
    decompressTempMaxAgeHours,
    decompressShowTokens,
  }
}

/**
 * 输入：插件上下文 + 可选 TUI 传来的层路径。
 * 输出：合并后的完整设置。
 * 预期：默认值 < 全局 < 远项目 < 近项目；坏层跳过，字段缺失按默认值补齐。
 */
export async function loadSettings(ctx: SettingsContext, layers?: readonly string[]): Promise<Settings> {
  const paths = resolveConfigFiles(ctx.location?.directory ?? process.cwd(), layers)
  const merged = await readMergedConfig(paths)
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
  const patch = diffConfig(merged.values, { ...normalized })
  if (patch === undefined) return
  const target = await nearestExistingConfig(paths)
  if (target === undefined) throw new Error("no plugin config path")
  const result = await writeConfigValues(target, patch)
  if (!result.ok) throw new Error(result.error)
}
