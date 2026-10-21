import { mix, toHex, toRgb, type Rgb } from "./color.ts"

/** 侧栏里折线图的默认尺寸：28 列 × 10 行（点阵 56 × 40）。 */
export const CHART_WIDTH = 28
export const CHART_HEIGHT = 10

/** 一个字符格：Braille 字符或空占位；空格的 color 为空串。 */
export interface ChartCell {
  readonly char: string
  readonly color: string
}

/** 命中率渐变色需要的三个主题色。 */
export interface ChartColors {
  readonly success: string
  readonly warning: string
  readonly error: string
}

/**
 * Braille 点阵位映射：每个字符 2 列 × 4 行。
 * 数组下标是 [dy][dx]，值是 U+2800 的位。
 */
const BRAILLE_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const

/** 空 cell 用不换行空格，防止 TUI 把连续空格吞掉。 */
const EMPTY_CELL = "\u00A0"

/** 网格线字符；只在没有折线点的 cell 上显示。 */
const GRID_CELL = "·"

/** 一条 y 轴刻度：行号 + 文本（`100%` / ` 75%` …）。 */
export interface ChartAxisLabel {
  readonly row: number
  readonly text: string
}

/**
 * 输入：图表高度（行）+ 标签步长（默认 10%）+ 网格步长（默认 20%）。
 * 输出：100/90/…/10 的刻度行号与文本，以及 80/60/40/20 的网格行。
 * 预期：10 行时 10% 正好一行；行不够时同行的低刻度会被丢弃，避免标签重叠。
 */
export function chartAxis(
  height: number,
  labelStep = 10,
  gridStep = 20,
): {
  readonly labels: readonly ChartAxisLabel[]
  readonly gridRows: readonly number[]
} {
  const rows = Math.max(1, Math.floor(height))
  const safeLabel = Math.max(1, Math.floor(labelStep))
  const safeGrid = Math.max(1, Math.floor(gridStep))
  const seen = new Set<number>()
  const labels: ChartAxisLabel[] = []
  for (let value = 100; value > 0; value -= safeLabel) {
    const row = Math.min(rows - 1, Math.max(0, Math.round(((100 - value) / 100) * rows)))
    if (seen.has(row)) continue
    seen.add(row)
    labels.push({ row, text: `${value.toString().padStart(3, " ")}%` })
  }
  const gridRows: number[] = []
  for (let value = 100 - safeGrid; value > 0; value -= safeGrid) {
    const row = Math.min(rows - 1, Math.max(0, Math.round(((100 - value) / 100) * rows)))
    if (!gridRows.includes(row)) gridRows.push(row)
  }
  return { labels, gridRows }
}

/**
 * 输入：样本数 + 绘图区宽度。
 * 输出：长度等于宽度的 x 轴标签行；每个点标 `1`…`n`。
 * 预期：标签居中在点的列上；宽度不够时后面的标签会覆盖前面的，属于可接受降级。
 */
export function xAxisLabels(count: number, width: number): string {
  const columns = Math.max(1, Math.floor(width))
  const chars = Array.from({ length: columns }, () => " ")
  if (count <= 0) return chars.join("")
  for (let index = 0; index < count; index += 1) {
    const label = (index + 1).toString()
    const position =
      count === 1 ? Math.floor((columns - 1) / 2) : Math.round((index * (columns - 1)) / (count - 1))
    const start = Math.min(columns - label.length, Math.max(0, position - Math.floor(label.length / 2)))
    for (let offset = 0; offset < label.length; offset += 1) {
      const target = start + offset
      if (target >= 0 && target < columns) chars[target] = label.charAt(offset)
    }
  }
  return chars.join("")
}

/** 输入：任意百分比；输出：夹在 0..100 的有限值。 */
function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

/**
 * 输入：命中率 + 主题色。
 * 输出：hex 颜色；0% 红、50% 黄、100% 绿，中间线性插值。
 */
export function hitRateColor(pct: number, colors: ChartColors): string {
  const red = toRgb(colors.error) ?? ([239, 68, 68] as Rgb)
  const yellow = toRgb(colors.warning) ?? ([234, 179, 8] as Rgb)
  const green = toRgb(colors.success) ?? ([34, 197, 94] as Rgb)
  const ratio = clampPercent(pct) / 100
  const rgb: Rgb =
    ratio >= 0.5 ? mix(yellow, green, (ratio - 0.5) * 2) : mix(red, yellow, ratio * 2)
  return toHex(rgb)
}

/** 输入：点阵坐标；输出：无；预期：越界点忽略。 */
function plot(points: Set<number>, width: number, height: number, x: number, y: number): void {
  if (x < 0 || x >= width || y < 0 || y >= height) return
  points.add(y * width + x)
}

/** 输入：两个点阵坐标；输出：无；预期：Bresenham 直线写入 points。 */
function line(
  points: Set<number>,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  const dx = Math.abs(x1 - x0)
  const sx = x0 < x1 ? 1 : -1
  const dy = -Math.abs(y1 - y0)
  const sy = y0 < y1 ? 1 : -1
  let error = dx + dy
  let x = x0
  let y = y0
  for (;;) {
    plot(points, width, height, x, y)
    if (x === x1 && y === y1) return
    const doubled = 2 * error
    if (doubled >= dy) {
      error += dy
      x += sx
    }
    if (doubled <= dx) {
      error += dx
      y += sy
    }
  }
}

/** 输入：列号 + 宽度 + 原始值；输出：该列中心插值出的百分比。 */
function valueAtColumn(column: number, width: number, values: readonly number[]): number {
  if (values.length === 1) return clampPercent(values[0] ?? 0)
  const ratio = (column + 0.5) / width
  const position = ratio * (values.length - 1)
  const left = Math.floor(position)
  const right = Math.min(values.length - 1, left + 1)
  const fraction = position - left
  const a = clampPercent(values[left] ?? 0)
  const b = clampPercent(values[right] ?? a)
  return a + (b - a) * fraction
}

/**
 * 输入：命中率序列（旧 → 新）、宽、高、逐列颜色函数。
 * 输出：按行排列的 Braille 折线；空 cell 是 NBSP。
 * 预期：0% 在底行，100% 在顶行；单点画水平线；空数组返回空。
 */
export function renderBrailleChart(
  values: readonly number[],
  width: number = CHART_WIDTH,
  height: number = CHART_HEIGHT,
  color: (pct: number) => string = () => "",
  gridRows: readonly number[] = [],
  gridColor = "",
): readonly (readonly ChartCell[])[] {
  if (values.length === 0) return []
  const columns = Math.max(1, Math.floor(width))
  const rows = Math.max(1, Math.floor(height))
  const dotWidth = columns * 2
  const dotHeight = rows * 4
  const points = new Set<number>()
  // 上下各留 1 个点阵行，避免 0%/100% 贴边看起来越过刻度。
  const top = 1
  const bottom = Math.max(top, dotHeight - 2)
  const yOf = (value: number): number =>
    Math.min(
      bottom,
      Math.max(top, Math.round(top + (1 - clampPercent(value) / 100) * (bottom - top))),
    )

  if (values.length === 1) {
    const value = values[0] ?? 0
    line(points, dotWidth, dotHeight, 0, yOf(value), dotWidth - 1, yOf(value))
  } else {
    for (let index = 0; index < values.length - 1; index += 1) {
      const x0 = Math.round((index * (dotWidth - 1)) / (values.length - 1))
      const x1 = Math.round(((index + 1) * (dotWidth - 1)) / (values.length - 1))
      line(
        points,
        dotWidth,
        dotHeight,
        x0,
        yOf(values[index] ?? 0),
        x1,
        yOf(values[index + 1] ?? 0),
      )
    }
  }

  const result: ChartCell[][] = []
  for (let row = 0; row < rows; row += 1) {
    const cells: ChartCell[] = []
    for (let column = 0; column < columns; column += 1) {
      let bits = 0
      for (let dy = 0; dy < 4; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          if (points.has((row * 4 + dy) * dotWidth + (column * 2 + dx))) {
            bits |= BRAILLE_BITS[dy]?.[dx] ?? 0
          }
        }
      }
      const pct = valueAtColumn(column, columns, values)
      const grid = bits === 0 && gridRows.includes(row)
      cells.push({
        char: bits === 0 ? (grid ? GRID_CELL : EMPTY_CELL) : String.fromCharCode(0x2800 + bits),
        color: bits === 0 ? (grid ? gridColor : "") : color(pct),
      })
    }
    result.push(cells)
  }
  return result
}
