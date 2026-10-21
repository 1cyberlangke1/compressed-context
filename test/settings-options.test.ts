import { describe, expect, it } from "vitest"

import { resolveMessages } from "../src/i18n/index.ts"
import { DEFAULT_SETTINGS } from "../src/shared/settings.ts"
import {
  SETTINGS_ACTIONS,
  buildSettingsOptions,
  limitLabel,
  percentLabel,
} from "../src/tui/settings/options.ts"

const copy = resolveMessages("zh")

describe("buildSettingsOptions", () => {
  it("按压缩/摘要/面板/解压/界面分组", () => {
    const options = buildSettingsOptions({ settings: DEFAULT_SETTINGS, copy, window: 200_000 })
    expect(options.map((option) => option.value)).toEqual([
      "limit",
      "threshold",
      "nudge",
      "autoCompress",
      "enableCompressTool",
      "enableDecompressTool",
      "blockPercent",
      "totalPercent",
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
      "decompressShowTokens",
      "language",
      "close",
    ])
    expect([...new Set(options.map((option) => option.category))]).toEqual([
      "压缩",
      "摘要",
      "面板",
      "解压",
      "界面",
    ])
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
    expect(options.find((option) => option.value === "limit")?.footer).toBe("模型原生 (32k)")
  })
})

describe("limitLabel / percentLabel", () => {
  it("数字上限被原生窗口压低时显示箭头", () => {
    expect(limitLabel({ ...DEFAULT_SETTINGS, contextLimit: 200_000 }, copy, 32_000)).toBe("200k → 32k")
    expect(limitLabel({ ...DEFAULT_SETTINGS, contextLimit: 100_000 }, copy, 200_000)).toBe("100k")
  })

  it("百分比标签带窗口换算", () => {
    expect(percentLabel(10, 200_000)).toBe("10% ≈ 20k")
    expect(percentLabel(10, undefined)).toBe("10%")
  })
})
