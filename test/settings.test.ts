import { describe, expect, it } from "vitest"

import {
  DEFAULT_SETTINGS,
  effectiveLimit,
  initialSettings,
  isLocaleSetting,
  localeArgument,
  normalizeSettings,
  parseTokenLimit,
  type ContextLimit,
  type Settings,
} from "../src/settings.ts"

describe("initialSettings", () => {
  it("没有 options 时使用默认值", () => {
    expect(initialSettings({})).toEqual(DEFAULT_SETTINGS)
  })

  it("合法 options 覆盖默认值", () => {
    expect(
      initialSettings({ enabled: false, expanded: false, locale: "en", contextLimit: 200_000 }),
    ).toEqual({
      enabled: false,
      expanded: false,
      locale: "en",
      contextLimit: 200_000,
    })
  })

  it("contextLimit 支持 auto / 数字 / 带单位字符串", () => {
    expect(initialSettings({ contextLimit: "auto" }).contextLimit).toBe("auto")
    expect(initialSettings({ contextLimit: 128_000 }).contextLimit).toBe(128_000)
    expect(initialSettings({ contextLimit: "200k" }).contextLimit).toBe(200_000)
    expect(initialSettings({ contextLimit: "1.5m" }).contextLimit).toBe(1_500_000)
  })

  it("非法值回退默认值", () => {
    expect(initialSettings({ enabled: "no", expanded: 1, locale: "fr", contextLimit: "abc" })).toEqual(
      DEFAULT_SETTINGS,
    )
  })
})

describe("parseTokenLimit", () => {
  it("解析数字与单位", () => {
    expect(parseTokenLimit("200000")).toBe(200_000)
    expect(parseTokenLimit("200k")).toBe(200_000)
    expect(parseTokenLimit("200K")).toBe(200_000)
    expect(parseTokenLimit("1m")).toBe(1_000_000)
    expect(parseTokenLimit("1.5m")).toBe(1_500_000)
    expect(parseTokenLimit(" 200k ")).toBe(200_000)
  })

  it("拒绝非法值与越界值", () => {
    expect(parseTokenLimit("")).toBeUndefined()
    expect(parseTokenLimit("abc")).toBeUndefined()
    expect(parseTokenLimit("0")).toBeUndefined()
    expect(parseTokenLimit("10")).toBeUndefined()
    expect(parseTokenLimit("100m")).toBeUndefined()
  })
})

describe("localeArgument", () => {
  it("auto 交给系统检测", () => {
    expect(localeArgument("auto")).toBeUndefined()
  })

  it("具体语言原样返回", () => {
    expect(localeArgument("zh")).toBe("zh")
    expect(localeArgument("en")).toBe("en")
  })
})

describe("isLocaleSetting", () => {
  it("只接受 auto / zh / en", () => {
    expect(isLocaleSetting("auto")).toBe(true)
    expect(isLocaleSetting("zh")).toBe(true)
    expect(isLocaleSetting("en")).toBe(true)
    expect(isLocaleSetting("fr")).toBe(false)
    expect(isLocaleSetting(1)).toBe(false)
    expect(isLocaleSetting(undefined)).toBe(false)
  })
})

describe("normalizeSettings", () => {
  it("补齐旧版本缺字段的设置", () => {
    expect(normalizeSettings({ enabled: true, expanded: true, locale: "zh" })).toEqual({
      enabled: true,
      expanded: true,
      locale: "zh",
      contextLimit: "auto",
    })
  })

  it("把字符串上限转成数字", () => {
    expect(normalizeSettings({ contextLimit: "200k" }).contextLimit).toBe(200_000)
  })

  it("非法字段回退默认值", () => {
    expect(normalizeSettings({ enabled: "x", locale: "fr", contextLimit: -1 })).toEqual(DEFAULT_SETTINGS)
  })
})

describe("effectiveLimit", () => {
  const base: Settings = DEFAULT_SETTINGS

  it("自定义值优先", () => {
    expect(effectiveLimit({ ...base, contextLimit: 200_000 }, 1_000_000)).toBe(200_000)
  })

  it("auto 回退模型原生值", () => {
    expect(effectiveLimit(base, 128_000)).toBe(128_000)
  })

  it("原生值未知时返回 undefined", () => {
    expect(effectiveLimit(base, 0)).toBeUndefined()
  })

  it("运行时的非法值按 auto 处理", () => {
    const broken = { ...base, contextLimit: undefined as unknown as ContextLimit }
    expect(effectiveLimit(broken, 128_000)).toBe(128_000)
  })
})
