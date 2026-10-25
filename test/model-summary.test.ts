import { describe, expect, test } from "vitest"

import { resolveMessages } from "../src/i18n/index.ts"
import { effectiveWindow, fieldLayers, layerLabel, summarySegments } from "../src/shared/model-summary.ts"
import { normalizeSettings, resolveForModel } from "../src/shared/settings.ts"

// 断言对照语言文件，改文案不用改测试。
const copy = resolveMessages("zh")

describe("fieldLayers", () => {
  test("没有覆盖时全部是全局", () => {
    expect(new Set(Object.values(fieldLayers(undefined, undefined)))).toEqual(new Set(["global"]))
  })

  test("同名覆盖的字段算 name", () => {
    const layers = fieldLayers(undefined, { triggerPercent: 90, summaryTotalPercent: 40 })
    expect(layers.triggerPercent).toBe("name")
    expect(layers.summaryTotalPercent).toBe("name")
    expect(layers.contextLimit).toBe("global")
  })

  test("精确覆盖优先于同名", () => {
    const layers = fieldLayers({ triggerPercent: 80 }, { triggerPercent: 90 })
    expect(layers.triggerPercent).toBe("exact")
  })
})

describe("layerLabel", () => {
  test("部分同名覆盖显示全局 + 同名", () => {
    expect(layerLabel(fieldLayers(undefined, { triggerPercent: 90 }), copy)).toBe(
      `${copy.modelPanel.sourceGlobal} + ${copy.modelPanel.sourceName}`,
    )
  })

  test("全字段同名覆盖只显示同名", () => {
    const all = {
      contextLimit: 768_000,
      triggerPercent: 88,
      nudgeGrowthTokens: 50_000,
      summaryBlockPercent: 1,
      summaryTotalPercent: 10,
      recentT1Blocks: 2,
    } as const
    expect(layerLabel(fieldLayers(undefined, all), copy)).toBe(copy.modelPanel.sourceName)
  })

  test("同名 + 精确混合", () => {
    const layers = fieldLayers({ contextLimit: 200_000 }, { triggerPercent: 88 })
    expect(layerLabel(layers, copy)).toBe(
      `${copy.modelPanel.sourceGlobal} + ${copy.modelPanel.sourceName} + ${copy.modelPanel.sourceExact}`,
    )
  })
})

describe("effectiveWindow", () => {
  test("auto 用原生窗口", () => {
    expect(effectiveWindow(resolveForModel(normalizeSettings({}), undefined), 1_000_000)).toBe(1_000_000)
  })

  test("按模型覆盖的上限与原生取小", () => {
    const settings = normalizeSettings({ models: { test: { contextLimit: 800_000 } } })
    const scoped = resolveForModel(settings, { providerID: "p", id: "test" })
    expect(effectiveWindow(scoped, 1_000_000)).toBe(800_000)
    expect(effectiveWindow(resolveForModel(normalizeSettings({ models: { t: { contextLimit: 2_000_000 } } }), { providerID: "p", id: "t" }), 1_000_000)).toBe(1_000_000)
  })

  test("原生未知时用数字上限", () => {
    const scoped = resolveForModel(normalizeSettings({ models: { t: { contextLimit: 200_000 } } }), { providerID: "p", id: "t" })
    expect(effectiveWindow(scoped, undefined)).toBe(200_000)
  })
})

describe("summarySegments", () => {
  test("完整字段名 + 折算 token + 来源层", () => {
    const scoped = resolveForModel(normalizeSettings({ triggerPercent: 90, summaryBlockPercent: 5, summaryTotalPercent: 7 }), undefined)
    const segments = summarySegments({
      scoped,
      native: 1_000_000,
      layers: fieldLayers(undefined, { triggerPercent: 90 }),
      copy,
    })
    expect(segments[0]).toEqual({ layer: "name", text: `${copy.modelPanel.icons.threshold} 90%（900k）` })
    expect(segments[1]).toEqual({ layer: "global", text: `${copy.modelPanel.icons.window} 1.0M（${copy.settings.limitAuto}）` })
    expect(segments[2]).toEqual({ layer: "global", text: `${copy.modelPanel.icons.block} 5%（50k）` })
    expect(segments[3]).toEqual({ layer: "global", text: `${copy.modelPanel.icons.total} 7%（70k）` })
    expect(segments[4]).toEqual({ layer: "global", text: `${copy.modelPanel.icons.recent} ${copy.modelPanel.recent("2")}` })
    expect(segments[5]).toEqual({ layer: "global", text: `${copy.modelPanel.icons.nudge} 50k` })
  })

  test("按模型覆盖的窗口被原生压低时走 limitCapped 文案", () => {
    const scoped = resolveForModel(normalizeSettings({ models: { t: { contextLimit: 2_000_000 } } }), { providerID: "p", id: "t" })
    const segments = summarySegments({
      scoped,
      native: 1_000_000,
      layers: fieldLayers(undefined, {}),
      copy,
    })
    expect(segments[1]?.text).toBe(
      `${copy.modelPanel.icons.window} ${copy.settings.limitCapped("2.0M", "1.0M")}`,
    )
  })

  test("窗口未知与提醒关闭", () => {
    const segments = summarySegments({
      scoped: resolveForModel(normalizeSettings({ nudgeGrowthTokens: 0 }), undefined),
      native: undefined,
      layers: fieldLayers(undefined, {}),
      copy,
    })
    expect(segments[1]?.text).toBe(`${copy.modelPanel.icons.window} ${copy.modelPanel.windowUnknown}`)
    expect(segments[5]?.text).toBe(`${copy.modelPanel.icons.nudge} ${copy.settings.off}`)
  })
})
