import { describe, expect, test } from "bun:test"

import { heightColor } from "../src/tui/panel/summaries"

/**
 * 输入：假的主题色。
 * 输出：带 info/warning/error 的主题对象。
 * 预期：heightColor 只读这三个语义色和主题无关字段，测试不需要真实 renderer。
 */
const theme = {
  text: {
    base: { r: 0.9, g: 0.9, b: 0.9, a: 1 },
    muted: { r: 0.5, g: 0.5, b: 0.5, a: 1 },
    feedback: {
      info: { base: { r: 0, g: 0, b: 1, a: 1 } },
      warning: { base: { r: 1, g: 1, b: 0, a: 1 } },
      error: { base: { r: 1, g: 0, b: 0, a: 1 } },
      success: { base: { r: 0, g: 1, b: 0, a: 1 } },
    },
  },
} as unknown as Parameters<typeof heightColor>[2]

/** 输入：颜色；输出：感知亮度。预期：用来比较"越深越暗"。 */
const luma = (color: { readonly r: number; readonly g: number; readonly b: number }): number =>
  0.299 * color.r + 0.587 * color.g + 0.114 * color.b

describe("heightColor", () => {
  test("深度 1 是青色（info），最大深度落在最深色", () => {
    const first = heightColor(1, 5, theme)
    expect(first.r).toBeCloseTo(theme.text.feedback.info.base.r, 3)
    expect(first.g).toBeCloseTo(theme.text.feedback.info.base.g, 3)
    expect(first.b).toBeCloseTo(theme.text.feedback.info.base.b, 3)
    const deepest = heightColor(5, 5, theme)
    // 最深色是暗红：红通道仍高，绿蓝接近 0.08。
    expect(deepest.r).toBeCloseTo(0.47, 2)
    expect(deepest.g).toBeCloseTo(0.08, 2)
  })

  test("浅层保持青色，只有深层才变红", () => {
    const shallow = heightColor(2, 7, theme)
    const middle = heightColor(3, 7, theme)
    const deep = heightColor(7, 7, theme)
    // 深度 2、3 仍以蓝（青）为主，红色通道很低。
    expect(shallow.b).toBeGreaterThan(0.9)
    expect(shallow.r).toBeLessThan(0.2)
    expect(middle.b).toBeGreaterThan(0.6)
    // 越深越偏红：深层的红通道明显高于浅层；最大深度落在暗红。
    expect(deep.r).toBeGreaterThan(shallow.r)
    expect(deep.r).toBeCloseTo(0.47, 2)
    expect(deep.g).toBeCloseTo(0.08, 2)
  })

  test("只有一层时不会除零", () => {
    const only = heightColor(1, 1, theme)
    expect(only.r).toBeCloseTo(theme.text.feedback.info.base.r, 3)
  })
})
