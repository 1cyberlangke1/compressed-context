import type { Messages } from "../i18n/index.ts"
import { formatTokens } from "./format.ts"
import {
  DEFAULT_SETTINGS,
  resolveSummaryLimits,
  triggerTokens,
  type CompressionSettings,
  type ModelOverrideField,
  type Settings,
} from "./settings.ts"

/** 可按模型覆盖的字段，顺序与配置一致。 */
const FIELDS: readonly ModelOverrideField[] = [
  "contextLimit",
  "triggerPercent",
  "nudgeGrowthTokens",
  "summaryBlockPercent",
  "summaryTotalPercent",
]

/** 来源层。 */
export type Layer = "default" | "global" | "name" | "exact"

/**
 * 输入：全局设置 + 精确/同名覆盖。
 * 输出：实际用到了哪些层，顺序 全局 → 同名 → 精确。
 * 预期：逐字段判定——精确优先，其次同名，再其次「全局是否偏离内置默认」，都没改就是默认。
 */
export function usedLayers(
  settings: Settings,
  exact: Settings["models"][string] | undefined,
  name: Settings["models"][string] | undefined,
): readonly Layer[] {
  const used = new Set<Layer>()
  for (const field of FIELDS) {
    if (exact?.[field] !== undefined) used.add("exact")
    else if (name?.[field] !== undefined) used.add("name")
    else if (settings[field] !== DEFAULT_SETTINGS[field]) used.add("global")
    else used.add("default")
  }
  const ordered = (["global", "name", "exact"] as const).filter((layer) => used.has(layer))
  return ordered.length === 0 ? ["default"] : ordered
}

/** 输入：生效窗口设置 + 模型原生窗口；输出：实际窗口。预期：数字是上限，与原生取小。 */
export function effectiveWindow(scoped: CompressionSettings, native: number | undefined): number | undefined {
  if (scoped.contextLimit === "auto") return native
  return native === undefined ? scoped.contextLimit : Math.min(scoped.contextLimit, native)
}

/**
 * 输入：该模型合并后的设置 + 原生窗口 + 文案。
 * 输出：一行要展示的片段（完整字段名 + 折算 token）。
 * 预期：窗口未知时明确写「未知」；提醒间隔为 0 时写「关」。
 */
export function summarySegments(input: {
  readonly scoped: CompressionSettings
  readonly native: number | undefined
  readonly copy: Messages
}): readonly string[] {
  const { scoped, native, copy } = input
  const limit = effectiveWindow(scoped, native)
  const threshold = triggerTokens(scoped, limit)
  const limits = resolveSummaryLimits(scoped, limit)
  const window =
    native === undefined
      ? copy.modelPanel.windowUnknown
      : scoped.contextLimit === "auto"
        ? copy.modelPanel.windowNative(formatTokens(native))
        : native < scoped.contextLimit
          ? copy.settings.limitCapped(formatTokens(scoped.contextLimit), formatTokens(native))
          : formatTokens(scoped.contextLimit)
  return [
    `${copy.settings.threshold} ${scoped.triggerPercent.toString()}%${
      threshold === undefined ? "" : `（${formatTokens(threshold)}）`
    }`,
    `${copy.modelPanel.window} ${window}`,
    `${copy.settings.summaryBlockPercent} ${scoped.summaryBlockPercent.toString()}%（${formatTokens(limits.blockChars)}）`,
    `${copy.settings.summaryTotalPercent} ${scoped.summaryTotalPercent.toString()}%（${formatTokens(limits.totalChars)}）`,
    `${copy.settings.nudgeGrowth} ${
      scoped.nudgeGrowthTokens === 0 ? copy.settings.off : formatTokens(scoped.nudgeGrowthTokens)
    }`,
  ]
}
