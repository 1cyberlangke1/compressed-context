import { describe, expect, test } from "bun:test"

import { depthColor } from "../src/tui/panel/summaries"

/**
 * 输入：假的主题色。
 * 输出：带 info/warning/error 的主题对象。
 * 预期：depthColor 只读这三个语义色和主题无关字段，测试不需要真实 renderer。
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
} as unknown as Parameters<typeof depthColor>[2]

/** 输入：颜色；输出：感知亮度。预期：用来比较"越深越暗"。 */
const luma = (color: { readonly r: number; readonly g: number; readonly b: number }): number =>
  0.299 * color.r + 0.587 * color.g + 0.114 * color.b

describe("depthColor", () => {
  test("深度 1 就是警告色，最大深度落在最深色", () => {
    const first = depthColor(1, 5, theme)
    expect(first.r).toBeCloseTo(theme.text.feedback.warning.base.r, 3)
    expect(first.g).toBeCloseTo(theme.text.feedback.warning.base.g, 3)
    expect(first.b).toBeCloseTo(theme.text.feedback.warning.base.b, 3)
    const deepest = depthColor(5, 5, theme)
    // 最深色是暗红：红通道仍高，绿蓝接近 0.08。
    expect(deepest.r).toBeCloseTo(0.47, 2)
    expect(deepest.g).toBeCloseTo(0.08, 2)
  })

  test("深度越大颜色越暗，且单调", () => {
    const values = [1, 2, 3, 4, 5].map((depth) => luma(depthColor(depth, 5, theme)))
    for (let index = 1; index < values.length; index += 1) {
      expect(values[index]).toBeLessThan(values[index - 1] ?? 0)
    }
  })

  test("只有一层时不会除零", () => {
    const only = depthColor(1, 1, theme)
    expect(only.r).toBeCloseTo(theme.text.feedback.warning.base.r, 3)
  })
})
