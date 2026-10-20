import { describe, expect, it } from "vitest"

import { hitRateColor, renderBrailleChart, type ChartCell } from "../src/tui/cache-chart.ts"

const COLORS = {
  success: "#00ff00",
  warning: "#ffff00",
  error: "#ff0000",
}

/** 输入：一行 cells；输出：是否有点。 */
function hasDots(row: readonly ChartCell[]): boolean {
  return row.some((cell) => cell.char !== "\u00A0")
}

describe("hitRateColor", () => {
  it("0% 红、50% 黄、100% 绿", () => {
    expect(hitRateColor(0, COLORS)).toBe("#ff0000")
    expect(hitRateColor(50, COLORS)).toBe("#ffff00")
    expect(hitRateColor(100, COLORS)).toBe("#00ff00")
  })

  it("中间值在两端之间插值", () => {
    const low = hitRateColor(25, COLORS)
    const high = hitRateColor(75, COLORS)
    expect(low).not.toBe("#ff0000")
    expect(low).not.toBe("#ffff00")
    expect(high).not.toBe("#ffff00")
    expect(high).not.toBe("#00ff00")
  })

  it("越界值夹紧", () => {
    expect(hitRateColor(-10, COLORS)).toBe("#ff0000")
    expect(hitRateColor(150, COLORS)).toBe("#00ff00")
  })
})

describe("renderBrailleChart", () => {
  it("空数组返回空", () => {
    expect(renderBrailleChart([], 10, 3)).toEqual([])
  })

  it("尺寸是 height 行 × width 列", () => {
    const rows = renderBrailleChart([10, 20, 30], 12, 4)
    expect(rows).toHaveLength(4)
    for (const row of rows) expect(row).toHaveLength(12)
  })

  it("全 0 只出现在底行", () => {
    const rows = renderBrailleChart([0, 0, 0], 10, 3)
    expect(hasDots(rows[0] ?? [])).toBe(false)
    expect(hasDots(rows[1] ?? [])).toBe(false)
    expect(hasDots(rows[2] ?? [])).toBe(true)
  })

  it("全 100 只出现在顶行", () => {
    const rows = renderBrailleChart([100, 100, 100], 10, 3)
    expect(hasDots(rows[0] ?? [])).toBe(true)
    expect(hasDots(rows[1] ?? [])).toBe(false)
    expect(hasDots(rows[2] ?? [])).toBe(false)
  })

  it("单值画水平线", () => {
    const rows = renderBrailleChart([50], 10, 3)
    const middle = rows[1] ?? []
    expect(hasDots(middle)).toBe(true)
    // 50% 落在中间行，顶行和底行不该有点。
    expect(hasDots(rows[0] ?? [])).toBe(false)
    expect(hasDots(rows[2] ?? [])).toBe(false)
  })

  it("颜色回调收到 0..100", () => {
    const seen: number[] = []
    renderBrailleChart([0, 100], 10, 3, (pct) => {
      seen.push(pct)
      return "#000000"
    })
    expect(seen.length).toBeGreaterThan(0)
    for (const pct of seen) {
      expect(pct).toBeGreaterThanOrEqual(0)
      expect(pct).toBeLessThanOrEqual(100)
    }
    expect(Math.max(...seen)).toBeGreaterThan(90)
    expect(Math.min(...seen)).toBeLessThan(10)
  })

  it("有点的 cell 有颜色，空格没有颜色", () => {
    const rows = renderBrailleChart([0, 0], 10, 3, () => "#123456")
    for (const row of rows) {
      for (const cell of row) {
        if (cell.char === "\u00A0") {
          expect(cell.color).toBe("")
        } else {
          expect(cell.color).toBe("#123456")
        }
      }
    }
  })
})
