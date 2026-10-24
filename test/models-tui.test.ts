import { describe, expect, test } from "vitest"

import { resolveMessages } from "../src/i18n/index.ts"
import { normalizeSettings } from "../src/shared/settings.ts"
import {
  buildEditorOptions,
  buildFieldRows,
  buildPickerOptions,
  filterPicker,
  providerCount,
  toEntries,
  windowOf,
  type ModelEntry,
} from "../src/tui/settings/models.ts"

const copy = resolveMessages("zh")

const ENTRIES: readonly ModelEntry[] = [
  { providerID: "google", id: "gemini-3-pro", name: "Gemini 3 Pro", limit: 1_000_000 },
  { providerID: "openrouter", id: "gemini-3-pro", name: "Gemini 3 Pro (OR)", limit: 1_000_000 },
  { providerID: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", limit: 200_000 },
]

describe("模型选择器", () => {
  test("当前模型排第一，已配置的排在未配置之前", () => {
    const options = buildPickerOptions({
      entries: ENTRIES,
      overrides: { "anthropic/claude-sonnet-4-5": { triggerPercent: 70 } },
      currentKey: "google/gemini-3-pro",
      copy,
    })
    expect(options[0]?.value).toEqual({ key: "google/gemini-3-pro" })
    expect(options[1]?.value).toEqual({ key: "anthropic/claude-sonnet-4-5" })
    expect(options[0]?.description).toBe(copy.settings.modelCurrent)
  })

  test("每个模型名都出现「仅模型名」项，不再限制提供商数量", () => {
    const options = buildPickerOptions({ entries: ENTRIES, overrides: {}, currentKey: undefined, copy })
    const nameOnly = options.filter((option) => !option.title.includes("]"))
    expect(nameOnly.map((option) => option.value)).toEqual([
      { key: "gemini-3-pro" },
      { key: "claude-sonnet-4-5" },
    ])
    expect(nameOnly[0]?.title).toBe("仅模型名（影响 2 个提供商）")
    expect(nameOnly[1]?.title).toBe("仅模型名（按名称匹配）")
    expect(providerCount(ENTRIES, "gemini-3-pro")).toBe(2)
  })

  test("搜索匹配提供商、模型名与备注", () => {
    const options = buildPickerOptions({ entries: ENTRIES, overrides: {}, currentKey: undefined, copy })
    expect(filterPicker("anthropic", options).length).toBe(1)
    expect(filterPicker("SONNET", options).map((option) => option.value)).toContainEqual({
      key: "anthropic/claude-sonnet-4-5",
    })
    expect(filterPicker("  ", options).length).toBe(options.length)
  })

  test("窗口按 key 解析", () => {
    expect(windowOf(ENTRIES, "anthropic/claude-sonnet-4-5")).toBe(200_000)
    expect(windowOf(ENTRIES, "gemini-3-pro")).toBe(1_000_000)
    expect(windowOf(toEntries(ENTRIES), "google/gemini-3-pro")).toBe(1_000_000)
  })
})

describe("覆盖编辑屏", () => {
  test("继承与已设两种状态，并折算成当前模型的 token", () => {
    const settings = normalizeSettings({
      models: { "google/gemini-3-pro": { triggerPercent: 90 } },
    })
    const rows = buildFieldRows({ settings, key: "google/gemini-3-pro", window: 1_000_000, copy })
    const threshold = rows.find((row) => row.field === "triggerPercent")
    expect(threshold?.overridden).toBe(true)
    expect(threshold?.value).toBe("90%")
    expect(threshold?.preview).toBe("900k")

    const total = rows.find((row) => row.field === "summaryTotalPercent")
    expect(total?.overridden).toBe(false)
    expect(total?.value).toBe("50%")
    expect(total?.preview).toBe("≈ 500k")
  })

  test("不同模型窗口下预览不同", () => {
    const settings = normalizeSettings({})
    const big = buildFieldRows({ settings, key: "google/gemini-3-pro", window: 1_000_000, copy })
    const small = buildFieldRows({ settings, key: "anthropic/claude-sonnet-4-5", window: 200_000, copy })
    expect(big.find((row) => row.field === "triggerPercent")?.preview).toBe("800k")
    expect(small.find((row) => row.field === "triggerPercent")?.preview).toBe("160k")
  })

  test("编辑项包含 5 个字段与重置/删除", () => {
    const settings = normalizeSettings({})
    const rows = buildFieldRows({ settings, key: "google/gemini-3-pro", window: 1_000_000, copy })
    const options = buildEditorOptions({ rows, copy })
    expect(options.length).toBe(7)
    expect(options.at(-1)?.value).toEqual({ kind: "delete" })
  })
})
