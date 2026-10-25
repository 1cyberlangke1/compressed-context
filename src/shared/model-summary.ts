import type { Messages } from "../i18n/index.ts"
import { formatTokens } from "./format.ts"
import {
  resolveSummaryLimits,
  triggerTokens,
  type ModelOverrideField,
  type ScopedSettings,
  type Settings,
} from "./settings.ts"

/** 可按模型覆盖的字段，顺序与配置一致。 */
const FIELDS: readonly ModelOverrideField[] = [
  "contextLimit",
  "triggerPercent",
  "nudgeGrowthTokens",
  "summaryBlockPercent",
  "summaryTotalPercent",
  "recentT1Blocks",
]

/** 字段来源层：全局（含内置默认）、同名覆盖、精确覆盖。 */
export type Layer = "global" | "name" | "exact"

/** 一行里的一个片段：文本 + 来源层，面板按层上色。 */
export interface Segment {
  readonly text: string
  readonly layer: Layer
}

/**
 * 输入：精确覆盖 + 同名覆盖。
 * 输出：每个字段的来源层。
 * 预期：精确优先，其次同名，都没有就是全局——全局本身已经包含内置默认，不再单独区分。
 */
export function fieldLayers(
  exact: Settings["models"][string] | undefined,
  name: Settings["models"][string] | undefined,
): Readonly<Record<ModelOverrideField, Layer>> {
  const layers = {} as Record<ModelOverrideField, Layer>
  for (const field of FIELDS) {
    layers[field] = exact?.[field] !== undefined ? "exact" : name?.[field] !== undefined ? "name" : "global"
  }
  return layers
}

/**
 * 输入：字段来源 + 文案。
 * 输出：来源标签，例如「全局 + 同名」。
 * 预期：只列出实际有字段来自的层；全部字段都被某层覆盖时只显示那一层。
 */
export function layerLabel(
  layers: Readonly<Record<ModelOverrideField, Layer>>,
  copy: Messages,
): string {
  const used = new Set<Layer>(Object.values(layers))
  const names: Record<Layer, string> = {
    global: copy.modelPanel.sourceGlobal,
    name: copy.modelPanel.sourceName,
    exact: copy.modelPanel.sourceExact,
  }
  return (["global", "name", "exact"] as const)
    .filter((layer) => used.has(layer))
    .map((layer) => names[layer])
    .join(" + ")
}

/** 输入：生效窗口设置 + 模型原生窗口；输出：实际窗口。预期：数字是上限，与原生取小。 */
export function effectiveWindow(scoped: ScopedSettings, native: number | undefined): number | undefined {
  if (scoped.contextLimit === "auto") return native
  return native === undefined ? scoped.contextLimit : Math.min(scoped.contextLimit, native)
}

/**
 * 输入：该模型合并后的设置 + 原生窗口 + 文案。
 * 输出：一行要展示的片段与各自来源。
 * 预期：窗口未知时明确写「未知」；提醒间隔为 0 时写「关」。
 */
export function summarySegments(input: {
  readonly scoped: ScopedSettings
  readonly native: number | undefined
  readonly layers: Readonly<Record<ModelOverrideField, Layer>>
  readonly copy: Messages
}): readonly Segment[] {
  const { scoped, native, layers, copy } = input
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
    {
      layer: layers.triggerPercent,
      text: `${copy.modelPanel.icons.threshold} ${scoped.triggerPercent.toString()}%${
        threshold === undefined ? "" : copy.modelPanel.wrap(formatTokens(threshold))
      }`,
    },
    { layer: layers.contextLimit, text: `${copy.modelPanel.icons.window} ${window}` },
    {
      layer: layers.summaryBlockPercent,
      text: `${copy.modelPanel.icons.block} ${scoped.summaryBlockPercent.toString()}%${copy.modelPanel.wrap(formatTokens(limits.blockChars))}`,
    },
    {
      layer: layers.summaryTotalPercent,
      text: `${copy.modelPanel.icons.total} ${scoped.summaryTotalPercent.toString()}%${copy.modelPanel.wrap(formatTokens(limits.totalChars))}`,
    },
    {
      layer: layers.recentT1Blocks,
      // 只留图标 + 数字；<=0 一律显示 0，不写文字。
      text: `${copy.modelPanel.icons.recent} ${Math.max(0, Math.round(scoped.recentT1Blocks)).toString()}`,
    },
    {
      layer: layers.nudgeGrowthTokens,
      text: `${copy.modelPanel.icons.nudge} ${
        scoped.nudgeGrowthTokens === 0 ? copy.settings.off : formatTokens(scoped.nudgeGrowthTokens)
      }`,
    },
  ]
}
