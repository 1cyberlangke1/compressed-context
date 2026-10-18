import { describe, expect, it } from "vitest"

import { DEFAULT_SETTINGS, initialSettings, isLocaleSetting, localeArgument } from "../src/settings.ts"

describe("initialSettings", () => {
  it("没有 options 时使用默认值", () => {
    expect(initialSettings({})).toEqual(DEFAULT_SETTINGS)
  })

  it("合法 options 覆盖默认值", () => {
    expect(initialSettings({ enabled: false, expanded: false, locale: "en" })).toEqual({
      enabled: false,
      expanded: false,
      locale: "en",
    })
  })

  it("非法值回退默认值", () => {
    expect(initialSettings({ enabled: "no", expanded: 1, locale: "fr" })).toEqual(DEFAULT_SETTINGS)
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
