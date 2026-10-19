import { describe, expect, it } from "vitest"

import {
  DEFAULT_SETTINGS,
  effectiveLimit,
  effectiveSummaryBudget,
  initialSettings,
  localeArgument,
  normalizeSettings,
  parseTokenCount,
  parseTokenLimit,
  sanitizeLimitInput,
  type ContextLimit,
  type Settings,
} from "../src/settings.ts"

describe("initialSettings / normalizeSettings", () => {
  it("缺字段时补默认值，合法值保留", () => {
    expect(initialSettings({})).toEqual(DEFAULT_SETTINGS)
    expect(initialSettings({ enabled: false, locale: "en", contextLimit: "200k" })).toEqual({
      enabled: false,
      expanded: true,
      locale: "en",
      contextLimit: 200_000,
      triggerPercent: 80,
      summaryBudgetTokens: 50_000,
    })
  })

  it("非法值回退默认值", () => {
    expect(initialSettings({ enabled: "no", expanded: 1, locale: "fr", contextLimit: "abc" })).toEqual(
      DEFAULT_SETTINGS,
    )
    expect(normalizeSettings({ enabled: true, locale: "zh" }).contextLimit).toBe("auto")
    expect(normalizeSettings({ summaryBudgetTokens: "80k" }).summaryBudgetTokens).toBe(80_000)
    expect(normalizeSettings({ summaryBudgetTokens: 4_999 }).summaryBudgetTokens).toBe(50_000)
  })
})

describe("parseTokenLimit", () => {
  it("解析纯数字与 k/m 后缀", () => {
    expect(parseTokenLimit("200000")).toBe(200_000)
    expect(parseTokenLimit("200k")).toBe(200_000)
    expect(parseTokenLimit("200K")).toBe(200_000)
    expect(parseTokenLimit("1m")).toBe(1_000_000)
  })

  it("拒绝非法值与越界值", () => {
    expect(parseTokenLimit("")).toBeUndefined()
    expect(parseTokenLimit("abc")).toBeUndefined()
    expect(parseTokenLimit("10")).toBeUndefined()
    expect(parseTokenLimit("100m")).toBeUndefined()
  })
})

describe("parseTokenCount", () => {
  it("按传入范围解析预算", () => {
    expect(parseTokenCount("50k", 5_000, 1_000_000)).toBe(50_000)
    expect(parseTokenCount("50000", 5_000, 1_000_000)).toBe(50_000)
    expect(parseTokenCount("1m", 5_000, 1_000_000)).toBe(1_000_000)
    expect(parseTokenCount("4k", 5_000, 1_000_000)).toBeUndefined()
    expect(parseTokenCount("2m", 5_000, 1_000_000)).toBeUndefined()
  })
})

describe("sanitizeLimitInput", () => {
  it("保留数字与结尾单位，统一小写", () => {
    expect(sanitizeLimitInput("200000")).toBe("200000")
    expect(sanitizeLimitInput("200K")).toBe("200k")
    expect(sanitizeLimitInput("1M")).toBe("1m")
  })

  it("丢弃非法字符", () => {
    expect(sanitizeLimitInput("2a0b0k")).toBe("200k")
    expect(sanitizeLimitInput("200k5")).toBe("200k")
    expect(sanitizeLimitInput("abc")).toBe("")
  })
})

describe("localeArgument", () => {
  it("auto 交给系统检测，具体语言原样返回", () => {
    expect(localeArgument("auto")).toBeUndefined()
    expect(localeArgument("zh")).toBe("zh")
  })
})

describe("effectiveLimit", () => {
  const base: Settings = DEFAULT_SETTINGS

  it("自定义优先，auto 回退模型原生值", () => {
    expect(effectiveLimit({ ...base, contextLimit: 200_000 }, 1_000_000)).toBe(200_000)
    expect(effectiveLimit(base, 128_000)).toBe(128_000)
    expect(effectiveLimit(base, 0)).toBeUndefined()
  })

  it("运行时的非法值按 auto 处理", () => {
    const broken = { ...base, contextLimit: undefined as unknown as ContextLimit }
    expect(effectiveLimit(broken, 128_000)).toBe(128_000)
  })
})

describe("effectiveSummaryBudget", () => {
  it("旧设置缺字段或非法值时回退 50k", () => {
    const missing = { ...DEFAULT_SETTINGS, summaryBudgetTokens: undefined as unknown as number }
    expect(effectiveSummaryBudget(missing)).toBe(50_000)
    expect(effectiveSummaryBudget({ ...DEFAULT_SETTINGS, summaryBudgetTokens: 0 })).toBe(50_000)
    expect(effectiveSummaryBudget({ ...DEFAULT_SETTINGS, summaryBudgetTokens: 80_000 })).toBe(80_000)
  })
})
