import type { DialogSelectOption } from "@opencode/plugin/tui/context"

import type { Messages } from "../../i18n/index.ts"
import { formatTokens } from "../../shared/format.ts"
import {
  resolveForModel,
  triggerTokens,
  type ModelIdentity,
  type ModelOverride,
  type ModelOverrideField,
  type ScopedSettings,
  type Settings,
} from "../../shared/settings.ts"

/** 模型选择器里的一项：只带渲染需要的信息。 */
export interface ModelEntry {
  readonly providerID: string
  readonly id: string
  readonly name: string
  readonly limit: number
}

/** 选择器的值就是配置里的键：`provider/id` 或单独的 `id`。 */
export interface PickerValue {
  readonly key: string
}

/** 编辑屏可执行的动作。 */
export type OverrideAction =
  | { readonly kind: "field"; readonly field: ModelOverrideField }
  | { readonly kind: "resetAll" }
  | { readonly kind: "delete" }
  | { readonly kind: "back" }

/** 输入：模型身份；输出：配置键。预期：`providerID/modelID`。 */
export function modelKey(model: ModelIdentity): string {
  return `${model.providerID}/${model.id}`
}

/** 输入：配置键；输出：是否精确键。预期：含 `/` 即精确，否则只按模型名。 */
export function isExactKey(key: string): boolean {
  return key.includes("/")
}

/** 输入：一条覆盖；输出：覆盖了几个字段。 */
export function overrideCount(override: ModelOverride | undefined): number {
  return override === undefined ? 0 : Object.keys(override).length
}

/** 输入：模型列表；输出：去重后的条目，保持原顺序。 */
export function toEntries(models: readonly ModelEntry[]): readonly ModelEntry[] {
  const seen = new Set<string>()
  const result: ModelEntry[] = []
  for (const model of models) {
    const key = modelKey(model)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(model)
  }
  return result
}

/** 输入：条目里的模型名；输出：提供该模型的提供商个数。 */
export function providerCount(entries: readonly ModelEntry[], id: string): number {
  return new Set(entries.filter((entry) => entry.id === id).map((entry) => entry.providerID)).size
}

/** 输入：模型名；输出：该名下的条目（用于算窗口）。 */
function entriesByName(entries: readonly ModelEntry[], id: string): readonly ModelEntry[] {
  return entries.filter((entry) => entry.id === id)
}

/**
 * 输入：模型条目 + 现有覆盖 + 当前模型键 + 文案。
 * 输出：选择器选项。
 * 预期：当前模型 → 已配置的精确项 → 其余精确项 → 已配置的模型名项 → 其余模型名项；
 *       同一模型不会只出现一次，精确项与模型名项是两条不同的配置。
 */
export function buildPickerOptions(input: {
  readonly entries: readonly ModelEntry[]
  readonly overrides: Readonly<Record<string, ModelOverride>>
  readonly currentKey: string | undefined
  readonly copy: Messages
}): readonly DialogSelectOption<PickerValue>[] {
  const { entries, overrides, currentKey, copy } = input
  const exact = entries.map((entry) => ({
    key: modelKey(entry),
    title: `[${entry.providerID}]${entry.id}`,
    footer: `${entry.name} · ${formatTokens(entry.limit)}`,
    configured: overrides[modelKey(entry)] !== undefined,
    isCurrent: modelKey(entry) === currentKey,
  }))

  const ids = [...new Set(entries.map((entry) => entry.id))]
  // 每个模型名都出一行「仅模型名」：只有一个提供商时它和精确项等价，但以后加了提供商不用再改配置。
  const nameOnly = ids.map((id) => ({ id, providers: providerCount(entries, id) })).map((item) => ({
      key: item.id,
      title: copy.settings.modelPickerNameOnly(item.providers),
      footer: item.id,
      configured: overrides[item.id] !== undefined,
      isCurrent: item.id === currentKey,
    }))

  const rank = (item: { configured: boolean; isCurrent: boolean }, group: number): number => {
    if (item.isCurrent) return 0
    if (item.configured) return 1
    return 2 + group
  }

  const ordered = [
    ...exact.map((item) => ({ item, rank: rank(item, 0) })),
    ...nameOnly.map((item) => ({ item, rank: rank(item, 1) })),
  ]
    .toSorted((left, right) => left.rank - right.rank)
    .map(({ item }) => ({
      title: item.title,
      value: { key: item.key },
      footer: item.configured ? `${item.footer} · ${copy.settings.modelConfigured}` : item.footer,
      ...(item.isCurrent ? { description: copy.settings.modelCurrent } : {}),
    }))

  return ordered
}

/** 输入：查询串 + 选项；输出：命中的选项。预期：标题与 footer 都不区分大小写匹配。 */
export function filterPicker(
  query: string,
  options: readonly DialogSelectOption<PickerValue>[],
): readonly DialogSelectOption<PickerValue>[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return options
  return options.filter((option) => {
    const haystack = `${option.title} ${option.footer ?? ""} ${option.description ?? ""}`.toLowerCase()
    return haystack.includes(needle)
  })
}

/** 输入：合并后的设置 + 模型原生窗口；输出：生效窗口。预期：数字上限与原生窗口取小。 */
export function effectiveWindow(
  settings: ScopedSettings,
  native: number | undefined,
): number | undefined {
  if (settings.contextLimit === "auto") return native
  return native === undefined ? settings.contextLimit : Math.min(settings.contextLimit, native)
}

/**
 * 输入：全局设置 + 覆盖 + 窗口 + 文案。
 * 输出：编辑屏的五行字段信息。
 * 预期：每行都给出「继承/已设」与实际值，并折算成当前模型的 token 数。
 */
export function buildFieldRows(input: {
  readonly settings: Settings
  readonly key: string
  readonly window: number | undefined
  readonly copy: Messages
}): readonly {
  readonly field: ModelOverrideField
  readonly label: string
  readonly overridden: boolean
  readonly value: string
  readonly preview: string
}[] {
  const { settings, key, window, copy } = input
  const override = settings.models[key] ?? {}
  const scoped = resolveScoped(settings, key)
  const limit = effectiveWindow(scoped, window)
  const threshold = triggerTokens(scoped, limit)
  const labels: Record<ModelOverrideField, string> = {
    contextLimit: copy.settings.limit,
    triggerPercent: copy.settings.threshold,
    nudgeGrowthTokens: copy.settings.nudgeGrowth,
    summaryBlockPercent: copy.settings.summaryBlockPercent,
    summaryTotalPercent: copy.settings.summaryTotalPercent,
    recentT1Blocks: copy.settings.recentT1Blocks,
  }
  return (
    [
      "contextLimit",
      "triggerPercent",
      "nudgeGrowthTokens",
      "summaryBlockPercent",
      "summaryTotalPercent",
      "recentT1Blocks",
    ] as const
  ).map((field) => {
    const overridden = override[field] !== undefined
    const raw = scoped[field]
    return {
      field,
      label: labels[field],
      overridden,
      value: formatFieldValue(field, raw, copy),
      preview: formatPreview(field, limit, threshold, scoped, window, copy),
    }
  })
}

/** 输入：字段 + 值 + 文案；输出：展示文本。 */
function formatFieldValue(field: ModelOverrideField, value: unknown, copy: Messages): string {
  if (field === "contextLimit") {
    if (value === "auto") return copy.settings.limitAuto
    return typeof value === "number" ? formatTokens(value) : copy.settings.limitAuto
  }
  if (field === "nudgeGrowthTokens") {
    return typeof value === "number" && value > 0 ? formatTokens(value) : copy.settings.off
  }
  if (field === "recentT1Blocks") {
    return typeof value === "number" ? value.toString() : "—"
  }
  return typeof value === "number" ? `${value.toString()}%` : "—"
}

/** 输入：字段 + 窗口 + 阈值 + 设置；输出：折算说明。 */
function formatPreview(
  field: ModelOverrideField,
  limit: number | undefined,
  threshold: number | undefined,
  settings: ScopedSettings,
  native: number | undefined,
  copy: Messages,
): string {
  if (field === "contextLimit") {
    // 值那一列已经是绝对 token，这里只说明原生窗口，避免重复显示同一个数。
    if (settings.contextLimit === "auto" || native === undefined) return ""
    return copy.modelPanel.windowNative(formatTokens(native))
  }
  if (field === "triggerPercent") return threshold === undefined ? "" : formatTokens(threshold)
  if (field === "nudgeGrowthTokens") return ""
  if (field === "recentT1Blocks") return ""
  if (limit === undefined) return ""
  const chars =
    field === "summaryBlockPercent"
      ? Math.round((limit * settings.summaryBlockPercent) / 100)
      : Math.round((limit * settings.summaryTotalPercent) / 100)
  return `≈ ${formatTokens(chars)}`
}

/**
 * 输入：全局设置 + 键。
 * 输出：该键对应的合并设置。
 * 预期：精确键按 provider 拆分；模型名键用空 provider 只命中名称级。
 */
export function resolveScoped(settings: Settings, key: string): ScopedSettings {
  if (isExactKey(key)) {
    const slash = key.indexOf("/")
    return resolveForModel(settings, { providerID: key.slice(0, slash), id: key.slice(slash + 1) })
  }
  return resolveForModel(settings, { providerID: "", id: key })
}

/**
 * 输入：字段行 + 文案。
 * 输出：编辑屏选项。
 * 预期：5 个字段 + 重置全部 / 删除 / 返回；footer 显示「继承 x」或「已设 x」并带折算值。
 */
export function buildEditorOptions(input: {
  readonly rows: ReturnType<typeof buildFieldRows>
  readonly copy: Messages
}): readonly DialogSelectOption<OverrideAction>[] {
  const { rows, copy } = input
  const fields = rows.map<DialogSelectOption<OverrideAction>>((row) => ({
    title: row.label,
    value: { kind: "field", field: row.field },
    footer: `${row.overridden ? copy.settings.overrideSet(row.value) : copy.settings.overrideInherited(row.value)}${
      row.preview.length > 0 ? `  ${row.preview}` : ""
    }`,
  }))
  return [
    ...fields,
    { title: copy.settings.overrideResetAll, value: { kind: "resetAll" } },
    { title: copy.settings.overrideDelete, value: { kind: "delete" } },
  ]
}

/** 输入：设置 + 条目；输出：当前模型键；预期：找不到时 undefined。 */
export function currentKeyOf(
  entries: readonly ModelEntry[],
  current: ModelIdentity | undefined,
): string | undefined {
  if (current === undefined) return undefined
  const key = modelKey(current)
  return entries.some((entry) => modelKey(entry) === key) ? key : undefined
}

/** 输入：模型名；输出：该名字下的第一个原生窗口；找不到时 undefined。 */
export function windowOf(entries: readonly ModelEntry[], key: string): number | undefined {
  if (isExactKey(key)) {
    const slash = key.indexOf("/")
    const providerID = key.slice(0, slash)
    const id = key.slice(slash + 1)
    return entries.find((entry) => entry.providerID === providerID && entry.id === id)?.limit
  }
  return entriesByName(entries, key)[0]?.limit
}
