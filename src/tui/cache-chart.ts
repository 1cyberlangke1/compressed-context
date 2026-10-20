import { mix, toHex, toRgb, type Rgb } from "./color.ts"

/** 侧栏里折线图的默认尺寸：26 列 × 5 行（点阵 52 × 20）。 */
export const CHART_WIDTH = 26
export const CHART_HEIGHT = 5

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
): readonly (readonly ChartCell[])[] {
  if (values.length === 0) return []
  const columns = Math.max(1, Math.floor(width))
  const rows = Math.max(1, Math.floor(height))
  const dotWidth = columns * 2
  const dotHeight = rows * 4
  const points = new Set<number>()
  const yOf = (value: number): number =>
    Math.round((1 - clampPercent(value) / 100) * (dotHeight - 1))

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
      cells.push({
        char: bits === 0 ? EMPTY_CELL : String.fromCharCode(0x2800 + bits),
        color: bits === 0 ? "" : color(pct),
      })
    }
    result.push(cells)
  }
  return result
}
