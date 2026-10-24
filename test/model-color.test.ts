import { describe, expect, test } from "vitest"

import { gradientAt, modelTint, tintAt } from "../src/shared/model-color.ts"

describe("modelTint", () => {
  test("Gemini 是蓝紫粉三段渐变", () => {
    expect(modelTint("gemini-3-pro", "google")).toEqual(["#4285F4", "#9B72CB", "#D96570"])
  })

  test("Google 四色排在 gemini 之后命中 gemma", () => {
    expect(modelTint("gemma-3-27b", "google")).toEqual(["#4285F4", "#EA4335", "#FBBC05", "#34A853"])
  })

  test("DeepSeek 是蓝白两段", () => {
    expect(modelTint("deepseek-v4.1-flash", "workbuddy2api")).toEqual(["#4D6BFE", "#FFFFFF"])
  })

  test("黑白品牌用灰阶区分", () => {
    expect(modelTint("kimi-k2", "moonshot")).toEqual(["#BDBDBD"])
    expect(modelTint("grok-4", "xai")).toEqual(["#6B7280"])
  })

  test("提供商命中兜底", () => {
    expect(modelTint("some-model", "anthropic")).toEqual(["#D97757"])
  })

  test("未知模型返回 undefined", () => {
    expect(modelTint("totally-unknown", "some-provider")).toBeUndefined()
  })
})

describe("gradientAt / tintAt", () => {
  const stops = ["#000000", "#FFFFFF"] as const

  test("两端取端点色", () => {
    expect(gradientAt(stops, 0)).toBe("#000000")
    expect(gradientAt(stops, 1)).toBe("#ffffff")
  })

  test("中点插值到中灰", () => {
    expect(gradientAt(stops, 0.5)).toBe("#808080")
  })

  test("越界钳到端点", () => {
    expect(gradientAt(stops, -1)).toBe("#000000")
    expect(gradientAt(stops, 2)).toBe("#ffffff")
  })

  test("多段按段插值", () => {
    const multi = ["#000000", "#FF0000", "#0000FF"] as const
    expect(gradientAt(multi, 0.5)).toBe("#ff0000")
    expect(gradientAt(multi, 0.25)).toBe("#800000")
  })

  test("单色不插值", () => {
    expect(gradientAt(["#123456"], 0.7)).toBe("#123456")
  })

  test("按字符位置取色", () => {
    expect(tintAt(stops, 0, 3)).toBe("#000000")
    expect(tintAt(stops, 2, 3)).toBe("#ffffff")
    expect(tintAt(stops, 0, 1)).toBe("#000000")
  })
})
