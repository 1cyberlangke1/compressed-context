import { describe, expect, it } from "vitest"

import { resolveMessages } from "../src/i18n/index.ts"
import { DEFAULT_SETTINGS } from "../src/shared/settings.ts"
import { PLUGIN_VERSION } from "../src/shared/version.ts"
import {
  SETTINGS_ACTIONS,
  buildModelSectionOptions,
  buildSectionOptions,
  buildSettingsOptions,
  itemsOfGroup,
  percentLabel,
} from "../src/tui/settings/options.ts"

const copy = resolveMessages("zh")

describe("buildSettingsOptions", () => {
  it("按压缩/摘要/面板/解压/界面分组", () => {
    const options = buildSettingsOptions({ settings: DEFAULT_SETTINGS, copy, window: 200_000 })
    expect(options.map((option) => option.value)).toEqual([
      "threshold",
      "nudge",
      "autoCompress",
      "enableCompressTool",
      "enableDecompressTool",
      "enableCheckpointTreeTool",
      "blockPercent",
      "totalPercent",
      "recentT1Blocks",
      "summaryLanguage",
      "summaryFormat",
      "showTimeline",
      "showBlockTokens",
      "show",
      "showCacheChart",
      "showCacheLog",
      "showSummaries",
      "decompressInlineMax",
      "decompressTempCap",
      "decompressTempMaxAgeHours",
      "decompressShowTokens",
      "language",
    ])
    expect(new Set(options.map((option) => option.category))).toEqual(
      new Set(["默认设置", "摘要", "开关", "解压", "界面"]),
    )
  })

  it("包含缓存与摘要显示开关", () => {
    const values = buildSettingsOptions({ settings: DEFAULT_SETTINGS, copy, window: 200_000 }).map(
      (option) => option.value,
    )
    expect(values).toContain("showCacheChart")
    expect(values).toContain("showCacheLog")
    expect(values).toContain("showSummaries")
  })

  it("SETTINGS_ACTIONS 与菜单项完全一致", () => {
    const options = buildSettingsOptions({ settings: DEFAULT_SETTINGS, copy, window: 200_000 })
    expect(new Set(options.map((option) => option.value))).toEqual(new Set(SETTINGS_ACTIONS))
  })

  it("footer 显示开关与上限", () => {
    const options = buildSettingsOptions({
      settings: { ...DEFAULT_SETTINGS, showCacheChart: false, showSummaries: false },
      copy,
      window: 32_000,
    })
    expect(options.find((option) => option.value === "showCacheChart")?.footer).toBe("关")
    expect(options.find((option) => option.value === "showSummaries")?.footer).toBe("关")
    expect(options.find((option) => option.value === "showCacheLog")?.footer).toBe("开")
  })
})

describe("percentLabel", () => {
  it("百分比标签带窗口换算", () => {
    expect(percentLabel(10, 200_000)).toBe("10% ≈ 20k")
    expect(percentLabel(10, undefined)).toBe("10%")
  })
})

describe("三层菜单", () => {
  it("第一层是默认设置 / 按模型 / 摘要 / 开关 / 解压 / 界面 / 检查更新", () => {
    const sections = buildSectionOptions({
      settings: DEFAULT_SETTINGS,
      copy,
      currentModel: "[google]gemini-3-pro",
    })
    expect(sections.map((section) => section.value)).toEqual([
      "defaults",
      "models",
      "summary",
      "switches",
      "decompress",
      "interface",
      "update",
    ])
    expect(sections[0]?.title).toBe("默认设置")
    expect(sections[1]?.footer).toBe("[google]gemini-3-pro")
    expect(sections.at(-1)?.title).toBe(copy.update.checkUpdates)
    expect(sections.at(-1)?.footer).toBe(`v${PLUGIN_VERSION}`)
  })

  it("默认设置只放数值项，不含开关与显示", () => {
    const all = buildSettingsOptions({ settings: DEFAULT_SETTINGS, copy, window: 200_000 })
    expect(itemsOfGroup(all, "defaults").map((option) => option.value)).toEqual([
      "threshold",
      "nudge",
      "blockPercent",
      "totalPercent",
      "recentT1Blocks",
    ])
    expect(itemsOfGroup(all, "switches").map((option) => option.value)).toEqual([
      "autoCompress",
      "enableCompressTool",
      "enableDecompressTool",
      "enableCheckpointTreeTool",
    ])
    expect(itemsOfGroup(all, "interface").map((option) => option.value)).toEqual([
      "show",
      "showCacheChart",
      "showCacheLog",
      "showSummaries",
      "language",
    ])
  })

  it("所有分组加起来不漏项", () => {
    const all = buildSettingsOptions({ settings: DEFAULT_SETTINGS, copy, window: 200_000 })
    const total = (["defaults", "summary", "switches", "decompress", "interface"] as const).reduce(
      (sum, group) => sum + itemsOfGroup(all, group).length,
      0,
    )
    expect(total).toBe(all.length)
  })

  it("按模型第一层显示当前模型与覆盖数量", () => {
    const options = buildModelSectionOptions({
      settings: { ...DEFAULT_SETTINGS, models: { "google/gemini-3-pro": { triggerPercent: 85 } } },
      copy,
      currentModel: "[google]gemini-3-pro",
    })
    expect(options.map((option) => option.value)).toEqual(["current", "overrides"])
    expect(options[1]?.footer).toBe("1 条")
  })
})
