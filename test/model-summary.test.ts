import { describe, expect, test } from "vitest"

import { resolveMessages } from "../src/i18n/index.ts"
import { effectiveWindow, joinSegments, summarySegments, usedLayers } from "../src/shared/model-summary.ts"
import { normalizeSettings } from "../src/shared/settings.ts"

// 断言对照语言文件，改文案不用改测试。
const copy = resolveMessages("zh")

describe("usedLayers", () => {
  test("全默认时只有 default", () => {
    expect(usedLayers(normalizeSettings({}), undefined, undefined)).toEqual(["default"])
  })

  test("全局改过字段就是 global", () => {
    expect(usedLayers(normalizeSettings({ triggerPercent: 90 }), undefined, undefined)).toEqual(["global"])
  })

  test("同名覆盖 + 全局改过", () => {
    const settings = normalizeSettings({ triggerPercent: 90, models: { "gemini-3-pro": { summaryTotalPercent: 40 } } })
    expect(usedLayers(settings, undefined, settings.models["gemini-3-pro"])).toEqual(["global", "name"])
  })

  test("精确覆盖优先级最高", () => {
    const settings = normalizeSettings({
      triggerPercent: 90,
      models: {
        "gemini-3-pro": { summaryTotalPercent: 40 },
        "google/gemini-3-pro": { contextLimit: 200_000 },
      },
    })
    expect(
      usedLayers(settings, settings.models["google/gemini-3-pro"], settings.models["gemini-3-pro"]),
    ).toEqual(["global", "name", "exact"])
  })
})

describe("effectiveWindow", () => {
  test("auto 用原生窗口", () => {
    expect(effectiveWindow(normalizeSettings({}), 1_000_000)).toBe(1_000_000)
  })

  test("数字上限与原生取小", () => {
    expect(effectiveWindow(normalizeSettings({ contextLimit: 800_000 }), 1_000_000)).toBe(800_000)
    expect(effectiveWindow(normalizeSettings({ contextLimit: 2_000_000 }), 1_000_000)).toBe(1_000_000)
  })

  test("原生未知时用数字上限", () => {
    expect(effectiveWindow(normalizeSettings({ contextLimit: 200_000 }), undefined)).toBe(200_000)
  })
})

describe("summarySegments", () => {
  test("完整字段名 + 折算 token", () => {
    const segments = summarySegments({
      scoped: normalizeSettings({ triggerPercent: 90, summaryBlockPercent: 5, summaryTotalPercent: 7 }),
      native: 1_000_000,
      copy,
    })
    expect(segments[0]).toBe(`${copy.modelPanel.icons.threshold} 90%（900k）`)
    expect(segments[1]).toBe(`${copy.modelPanel.icons.window} 1.0M（${copy.settings.limitAuto}）`)
    expect(segments[2]).toBe(`${copy.modelPanel.icons.block} 5%（50k）`)
    expect(segments[3]).toBe(`${copy.modelPanel.icons.total} 7%（70k）`)
    expect(segments[4]).toBe(`${copy.modelPanel.icons.nudge} 50k`)
  })

  test("数字上限被原生窗口压低时走 limitCapped 文案", () => {
    const segments = summarySegments({
      scoped: normalizeSettings({ contextLimit: 2_000_000 }),
      native: 1_000_000,
      copy,
    })
    expect(segments[1]).toBe(`${copy.modelPanel.icons.window} ${copy.settings.limitCapped("2.0M", "1.0M")}`)
  })

  test("窗口未知与提醒关闭", () => {
    const segments = summarySegments({
      scoped: normalizeSettings({ nudgeGrowthTokens: 0 }),
      native: undefined,
      copy,
    })
    expect(segments[1]).toBe(`${copy.modelPanel.icons.window} ${copy.modelPanel.windowUnknown}`)
    expect(segments[4]).toBe(`${copy.modelPanel.icons.nudge} ${copy.settings.off}`)
  })
})

describe("joinSegments", () => {
  test("片段之间用两个空格，字段内部用不换行空格", () => {
    const line = joinSegments(["压缩阈值 90%（900k）", "上下文窗口 1.0M（模型原生）"])
    expect(line).toBe("压缩阈值\u00A090%（900k）  上下文窗口\u00A01.0M（模型原生）")
    expect(line.split("  ")).toHaveLength(2)
  })
})
