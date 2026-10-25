import { describe, expect, test } from "vitest"

import {
  normalizeModelOverrides,
  normalizeSettings,
  pruneModelOverride,
  resolveForModel,
  resolveSummaryLimits,
  triggerTokens,
  type Settings,
} from "../src/shared/settings.ts"

/** 输入：无；输出：全局默认设置。预期：models 为空，阈值 80%。 */
function baseSettings(): Settings {
  return normalizeSettings({})
}

const CLAUDE = { providerID: "anthropic", id: "claude-sonnet-4-5" }
const GEMINI = { providerID: "google", id: "gemini-3-pro" }

describe("按模型解析设置", () => {
  test("默认值按各自窗口折算，不同模型阈值不同", () => {
    const settings = baseSettings()
    expect(triggerTokens(resolveForModel(settings, CLAUDE), 200_000)).toBe(160_000)
    expect(triggerTokens(resolveForModel(settings, GEMINI), 1_000_000)).toBe(800_000)
  })

  test("精确键覆盖模型名键，模型名键覆盖全局", () => {
    const settings = normalizeSettings({
      triggerPercent: 80,
      models: {
        "claude-sonnet-4-5": { triggerPercent: 70 },
        "anthropic/claude-sonnet-4-5": { triggerPercent: 60 },
      },
    })
    expect(resolveForModel(settings, CLAUDE).triggerPercent).toBe(60)
    expect(resolveForModel(settings, { providerID: "openrouter", id: "claude-sonnet-4-5" }).triggerPercent).toBe(70)
    expect(resolveForModel(settings, GEMINI).triggerPercent).toBe(80)
  })

  test("只写一个字段时其余字段继续继承", () => {
    const settings = normalizeSettings({
      summaryTotalPercent: 50,
      models: { "google/gemini-3-pro": { contextLimit: 180_000 } },
    })
    const scoped = resolveForModel(settings, GEMINI)
    expect(scoped.contextLimit).toBe(180_000)
    expect(scoped.summaryTotalPercent).toBe(50)
    expect(scoped.triggerPercent).toBe(80)
  })

  test("模型缺省或没有覆盖时等于全局设置", () => {
    const settings = baseSettings()
    expect(resolveForModel(settings, undefined)).toEqual(resolveForModel(settings, GEMINI))
    expect(resolveForModel(settings, GEMINI).triggerPercent).toBe(settings.triggerPercent)
  })

  test("阈值随 triggerPercent 变化，窗口相同也各自独立", () => {
    const settings = normalizeSettings({ models: { "google/gemini-3-pro": { triggerPercent: 90 } } })
    expect(triggerTokens(resolveForModel(settings, GEMINI), 1_000_000)).toBe(900_000)
    expect(triggerTokens(resolveForModel(settings, CLAUDE), 1_000_000)).toBe(800_000)
  })

  test("窗口未知时不给阈值，避免瞎算", () => {
    expect(triggerTokens(baseSettings(), undefined)).toBeUndefined()
    expect(triggerTokens(baseSettings(), 0)).toBeUndefined()
  })

  test("摘要预算按窗口分别折算", () => {
    const settings = baseSettings()
    expect(resolveSummaryLimits(settings, 200_000).totalChars).toBeLessThan(
      resolveSummaryLimits(settings, 1_000_000).totalChars,
    )
  })
})

describe("模型覆盖归一化", () => {
  test("丢弃空键、空白键、非对象和没有合法字段的条目", () => {
    const models = normalizeModelOverrides({
      "": { triggerPercent: 70 },
      "bad key": { triggerPercent: 70 },
      "ok/model": { triggerPercent: 70 },
      empty: {},
      broken: "nope",
      "bad/value": { triggerPercent: 10 },
    })
    expect(Object.keys(models)).toEqual(["ok/model"])
  })

  test("范围外的值被丢弃，合法值保留", () => {
    const models = normalizeModelOverrides({
      m: { triggerPercent: 99, summaryTotalPercent: 40, nudgeGrowthTokens: 0, contextLimit: "200k" },
    })
    expect(models["m"]).toEqual({ summaryTotalPercent: 40, nudgeGrowthTokens: 0, contextLimit: 200_000 })
  })

  test("保留压缩块数原样保留，不设上下限", () => {
    const models = normalizeModelOverrides({
      m: { recentT1Blocks: 11 },
      n: { recentT1Blocks: 0 },
      p: { recentT1Blocks: -1 },
    })
    expect(models["m"]).toEqual({ recentT1Blocks: 11 })
    expect(models["n"]).toEqual({ recentT1Blocks: 0 })
    // 负数没有意义，但配置层不做钳制；合并时按 0 处理（distill 里 Math.max(0, ...)）。
    expect(models["p"]).toEqual({ recentT1Blocks: -1 })
  })

  test("按模型覆盖保留压缩块数", () => {
    const settings = normalizeSettings({ models: { "p/m": { recentT1Blocks: 5 } } })
    expect(resolveForModel(settings, { providerID: "p", id: "m" }).recentT1Blocks).toBe(5)
    expect(resolveForModel(settings, { providerID: "other", id: "m" }).recentT1Blocks).toBe(2)
  })
})

describe("保存前裁剪", () => {
  test("等于继承值的字段被去掉，全等时整条返回 undefined", () => {
    const base = resolveForModel(baseSettings(), undefined)
    expect(pruneModelOverride({ triggerPercent: 80 }, base)).toBeUndefined()
    expect(pruneModelOverride({ triggerPercent: 85, summaryTotalPercent: 50 }, base)).toEqual({ triggerPercent: 85 })
    // 保留压缩块数与继承值相同就删除，不同才保留。
    expect(pruneModelOverride({ recentT1Blocks: 2 }, base)).toBeUndefined()
    expect(pruneModelOverride({ recentT1Blocks: 4 }, base)).toEqual({ recentT1Blocks: 4 })
  })
})
