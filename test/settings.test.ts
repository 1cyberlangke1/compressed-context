import { describe, expect, it } from "vitest"

import {
  DEFAULT_SETTINGS,
  SUMMARY_WINDOW_RESERVE,
  effectiveLimit,
  effectiveDecompressInlineMax,
  effectiveDecompressTempCap,
  effectiveDecompressTempMaxAgeHours,
  effectiveSummaryBlockPercent,
  effectiveSummaryLanguage,
  effectiveSummaryTotalPercent,
  initialSettings,
  localeArgument,
  maxSummaryPercent,
  normalizeSettings,
  parseSummaryPercent,
  parseTokenCount,
  parseTokenLimit,
  percentToChars,
  resolveSummaryLimits,
  sanitizeLimitInput,
  type ContextLimit,
  type Settings,
} from "../src/shared/settings.ts"

describe("initialSettings / normalizeSettings", () => {
  it("缺字段时补默认值，合法值保留", () => {
    expect(initialSettings({})).toEqual(DEFAULT_SETTINGS)
    expect(initialSettings({ enabled: false, locale: "en", contextLimit: "200k" })).toEqual({
      enabled: false,
      expanded: true,
      locale: "en",
      contextLimit: 200_000,
      triggerPercent: 80,
      nudgeGrowthTokens: 50_000,
      summaryBlockPercent: 10,
      summaryTotalPercent: 50,
      summaryLanguage: "auto",
      summaryFormat: "markdown",
      autoCompress: true,
      enableCompressTool: true,
      enableDecompressTool: true,
      showTimeline: false,
      showBlockTokens: false,
      cacheExpanded: true,
      showCacheChart: true,
      cacheChartExpanded: true,
      showCacheLog: true,
      cacheLogExpanded: false,
      showSummaries: true,
      summariesExpanded: true,
      nativeCompactionPromptDismissed: false,
      decompressInlineMax: 10_000,
      decompressTempCap: 50,
      decompressTempMaxAgeHours: 24,
      decompressShowTokens: true,
    })
  })

  it("摘要百分比可配置，非法值回退，单条与全部互相独立", () => {
    const settings = initialSettings({
      summaryBlockPercent: 20,
      summaryTotalPercent: 60,
      summaryLanguage: "zh",
    })
    expect(settings.summaryBlockPercent).toBe(20)
    expect(settings.summaryTotalPercent).toBe(60)
    expect(settings.summaryLanguage).toBe("zh")

    for (const bad of [0, 91, Number.NaN, Number.POSITIVE_INFINITY, -1, "20"]) {
      expect(initialSettings({ summaryBlockPercent: bad }).summaryBlockPercent).toBe(10)
    }
    for (const bad of [0, 91, Number.NaN, Number.POSITIVE_INFINITY, -1, "60"]) {
      expect(initialSettings({ summaryTotalPercent: bad }).summaryTotalPercent).toBe(50)
    }
    // 单条允许大于全部：全部是合并触发线，不是单条的硬上限。
    expect(initialSettings({ summaryBlockPercent: 30, summaryTotalPercent: 20 }).summaryTotalPercent).toBe(20)
    expect(initialSettings({ summaryLanguage: "fr" }).summaryLanguage).toBe("auto")
  })

  it("旧设置缺失或非法时 effective 回退", () => {
    expect(effectiveSummaryBlockPercent({ ...DEFAULT_SETTINGS, summaryBlockPercent: Number.NaN })).toBe(10)
    expect(
      effectiveSummaryTotalPercent({
        ...DEFAULT_SETTINGS,
        summaryBlockPercent: 30,
        summaryTotalPercent: 10,
      }),
    ).toBe(10)
    expect(
      effectiveSummaryLanguage({
        ...DEFAULT_SETTINGS,
        summaryLanguage: "fr" as Settings["summaryLanguage"],
      }),
    ).toBe("auto")
  })

  it("resolveSummaryLimits 按窗口百分比折算，未知窗口回退默认", () => {
    expect(resolveSummaryLimits(DEFAULT_SETTINGS, undefined)).toEqual({
      blockChars: 20_000,
      totalChars: 100_000,
      budgetTokens: 100_000,
    })
    expect(resolveSummaryLimits(DEFAULT_SETTINGS, Number.NaN)).toEqual({
      blockChars: 20_000,
      totalChars: 100_000,
      budgetTokens: 100_000,
    })
    expect(resolveSummaryLimits(DEFAULT_SETTINGS, 200_000)).toEqual({
      blockChars: 20_000,
      totalChars: 100_000,
      budgetTokens: 100_000,
    })
    expect(resolveSummaryLimits(DEFAULT_SETTINGS, 50_000)).toEqual({
      blockChars: 5_000,
      totalChars: 25_000,
      budgetTokens: 25_000,
    })
    // 窗口小于预留时物理上放不下，上限归零，由校验报真实原因。
    expect(resolveSummaryLimits(DEFAULT_SETTINGS, SUMMARY_WINDOW_RESERVE)).toEqual({
      blockChars: 0,
      totalChars: 0,
      budgetTokens: 0,
    })
  })

  it("非法值回退默认值", () => {
    expect(initialSettings({ enabled: "no", expanded: 1, locale: "fr", contextLimit: "abc" })).toEqual(
      DEFAULT_SETTINGS,
    )
    expect(initialSettings({ nativeCompactionPromptDismissed: true }).nativeCompactionPromptDismissed).toBe(true)
    expect(initialSettings({ nativeCompactionPromptDismissed: "yes" }).nativeCompactionPromptDismissed).toBe(false)
    expect(normalizeSettings({ enabled: true, locale: "zh" }).contextLimit).toBe("auto")
    expect(normalizeSettings({ summaryBlockPercent: 200 }).summaryBlockPercent).toBe(10)
    expect(initialSettings({ summaryFormat: "babel" }).summaryFormat).toBe("babel")
    expect(initialSettings({ summaryFormat: "xml" }).summaryFormat).toBe("markdown")
  })

  it("新开关与 decompress 限制可配置，非法值回退", () => {
    const settings = initialSettings({
      autoCompress: false,
      enableCompressTool: false,
      enableDecompressTool: false,
      showTimeline: true,
      showBlockTokens: true,
      decompressInlineMax: 5_000,
      decompressTempCap: 10,
      decompressTempMaxAgeHours: 48,
      decompressShowTokens: false,
    })
    expect(settings.autoCompress).toBe(false)
    expect(settings.enableCompressTool).toBe(false)
    expect(settings.enableDecompressTool).toBe(false)
    expect(settings.showTimeline).toBe(true)
    expect(settings.showBlockTokens).toBe(true)
    expect(settings.decompressInlineMax).toBe(5_000)
    expect(settings.decompressTempCap).toBe(10)
    expect(settings.decompressTempMaxAgeHours).toBe(48)
    expect(settings.decompressShowTokens).toBe(false)

    expect(initialSettings({ autoCompress: "no" }).autoCompress).toBe(true)
    expect(initialSettings({ enableCompressTool: "no" }).enableCompressTool).toBe(true)
    expect(initialSettings({ enableDecompressTool: "no" }).enableDecompressTool).toBe(true)
    expect(initialSettings({ decompressInlineMax: 999 }).decompressInlineMax).toBe(10_000)
    expect(initialSettings({ decompressInlineMax: 2_000_000 }).decompressInlineMax).toBe(10_000)
    expect(initialSettings({ decompressTempCap: 0 }).decompressTempCap).toBe(50)
    expect(initialSettings({ decompressTempCap: 2_000 }).decompressTempCap).toBe(50)
    expect(initialSettings({ decompressTempMaxAgeHours: 0 }).decompressTempMaxAgeHours).toBe(24)
    expect(initialSettings({ decompressTempMaxAgeHours: 721 }).decompressTempMaxAgeHours).toBe(24)
    expect(effectiveDecompressInlineMax({ decompressInlineMax: Number.NaN })).toBe(10_000)
    expect(effectiveDecompressTempCap({ decompressTempCap: 0 })).toBe(50)
    expect(effectiveDecompressTempMaxAgeHours({ decompressTempMaxAgeHours: 0 })).toBe(24)
  })

  it("面板显示项可配置，非法值回退", () => {
    const settings = initialSettings({
      cacheExpanded: false,
      showCacheChart: false,
      cacheChartExpanded: false,
      showCacheLog: false,
      cacheLogExpanded: false,
      showSummaries: false,
      summariesExpanded: false,
    })
    expect(settings.cacheExpanded).toBe(false)
    expect(settings.showCacheChart).toBe(false)
    expect(settings.cacheChartExpanded).toBe(false)
    expect(settings.showCacheLog).toBe(false)
    expect(settings.cacheLogExpanded).toBe(false)
    expect(settings.showSummaries).toBe(false)
    expect(settings.summariesExpanded).toBe(false)

    expect(initialSettings({ showCacheChart: "no" }).showCacheChart).toBe(true)
  })
})

describe("parseSummaryPercent", () => {
  it("接受百分比写法", () => {
    expect(parseSummaryPercent("10%", undefined)).toBe(10)
    expect(parseSummaryPercent(" 12.5% ", 200_000)).toBe(12.5)
    expect(parseSummaryPercent("0.5%", 200_000)).toBeUndefined()
    expect(parseSummaryPercent("95%", 200_000)).toBeUndefined()
    expect(parseSummaryPercent("abc%", 200_000)).toBeUndefined()
  })

  it("绝对值按窗口换算", () => {
    expect(parseSummaryPercent("20k", 200_000)).toBe(10)
    expect(parseSummaryPercent("20000", 200_000)).toBe(10)
    expect(parseSummaryPercent("500", 50_000)).toBe(1)
    expect(parseSummaryPercent("20k", undefined)).toBeUndefined()
    expect(parseSummaryPercent("100", 200_000)).toBeUndefined()
  })

  it("percentToChars / maxSummaryPercent 跟着窗口缩放", () => {
    expect(percentToChars(10, 200_000)).toBe(20_000)
    expect(percentToChars(10, undefined)).toBeUndefined()
    expect(maxSummaryPercent(undefined)).toBe(90)
    expect(maxSummaryPercent(200_000)).toBe(90)
    expect(maxSummaryPercent(50_000)).toBe(80)
    expect(maxSummaryPercent(20_000)).toBe(50)
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

  it("摘要字符上限的边界", () => {
    expect(parseTokenCount("20k", 500, 100_000)).toBe(20_000)
    expect(parseTokenCount("499", 500, 100_000)).toBeUndefined()
    expect(parseTokenCount("100001", 500, 100_000)).toBeUndefined()
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
    // 数字设置是上限：模型原生窗口更小时取原生值。
    expect(effectiveLimit({ ...base, contextLimit: 200_000 }, 32_000)).toBe(32_000)
    expect(effectiveLimit(base, 128_000)).toBe(128_000)
    expect(effectiveLimit(base, 0)).toBeUndefined()
  })

  it("运行时的非法值按 auto 处理", () => {
    const broken = { ...base, contextLimit: undefined as unknown as ContextLimit }
    expect(effectiveLimit(broken, 128_000)).toBe(128_000)
  })
})
