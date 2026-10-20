import { describe, expect, it } from "vitest"

import { hitRateColor, renderBrailleChart, chartAxis, xAxisLabels, type ChartCell } from "../src/tui/chart/cache-chart.ts"

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

  it("网格行在没有折线点时显示 ·", () => {
    const rows = renderBrailleChart([0, 0], 10, 3, () => "#123456", [1], "#abc")
    for (const cell of rows[1] ?? []) {
      expect(cell.char).toBe("·")
      expect(cell.color).toBe("#abc")
    }
    // 底行是折线，不是网格。
    expect(rows[2]?.some((cell) => cell.char !== "·")).toBe(true)
  })
})

describe("chartAxis", () => {
  it("10 行时 10% 一档，正好一行一个刻度", () => {
    const axis = chartAxis(10)
    expect(axis.labels.map((label) => label.text)).toEqual([
      "100%",
      " 90%",
      " 80%",
      " 70%",
      " 60%",
      " 50%",
      " 40%",
      " 30%",
      " 20%",
      " 10%",
    ])
    expect(axis.labels.map((label) => label.row)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    // 网格按 20% 画，避免 10 条线太密。
    expect(axis.gridRows).toEqual([2, 4, 6, 8])
  })

  it("8 行时同行的低刻度被丢弃，标签不重叠", () => {
    const axis = chartAxis(8)
    expect(axis.labels.map((label) => label.row)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(axis.labels.map((label) => label.text)).toEqual([
      "100%",
      " 90%",
      " 80%",
      " 60%",
      " 50%",
      " 40%",
      " 30%",
      " 10%",
    ])
    expect(axis.gridRows).toEqual([2, 3, 5, 6])
  })
})

describe("xAxisLabels", () => {
  it("10 个点标 1..10", () => {
    const labels = xAxisLabels(10, 28)
    expect(labels).toHaveLength(28)
    expect(labels.charAt(0)).toBe("1")
    expect(labels.slice(26)).toBe("10")
  })

  it("没有样本时全空格", () => {
    expect(xAxisLabels(0, 10)).toBe("          ")
  })
})
