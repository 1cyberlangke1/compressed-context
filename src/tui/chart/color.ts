/** 颜色三元组，分量 0-255。 */
export type Rgb = readonly [number, number, number]

/** 主题色解析不出来时的兜底色：成功 / 警告 / 错误。 */
export const FALLBACK_SUCCESS: Rgb = [34, 197, 94]
export const FALLBACK_WARNING: Rgb = [234, 179, 8]
export const FALLBACK_ERROR: Rgb = [239, 68, 68]

/** 输入：0-255 分量；输出：两位十六进制。 */
function channel(value: number): string {
  return Math.round(value).toString(16).padStart(2, "0")
}

/** 输入：颜色值；输出：RGB；不是 hex 返回 undefined。 */
export function parseHex(value: string): Rgb | undefined {
  const match = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.exec(value.trim())
  const raw = match?.[1]
  if (raw === undefined) return undefined
  if (raw.length === 3 || raw.length === 4) {
    return [
      parseInt(raw.charAt(0).repeat(2), 16),
      parseInt(raw.charAt(1).repeat(2), 16),
      parseInt(raw.charAt(2).repeat(2), 16),
    ]
  }
  return [
    parseInt(raw.slice(0, 2), 16),
    parseInt(raw.slice(2, 4), 16),
    parseInt(raw.slice(4, 6), 16),
  ]
}

/** 输入：两个颜色 + 0-1 比例；输出：线性插值后的颜色。 */
export function mix(from: Rgb, to: Rgb, ratio: number): Rgb {
  return [
    from[0] + (to[0] - from[0]) * ratio,
    from[1] + (to[1] - from[1]) * ratio,
    from[2] + (to[2] - from[2]) * ratio,
  ]
}

/** 输入：RGB；输出：hex 字符串。 */
export function toHex(rgb: Rgb): string {
  return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`
}

/** 输入：颜色值（hex 字符串或 OpenTUI RGBA）；输出：RGB。 */
export function toRgb(value: unknown): Rgb | undefined {
  if (typeof value === "string") return parseHex(value)
  if (typeof value === "object" && value !== null) {
    const color = value as { readonly r?: unknown; readonly g?: unknown; readonly b?: unknown }
    if (typeof color.r === "number" && typeof color.g === "number" && typeof color.b === "number") {
      // OpenTUI 的 RGBA.r/g/b 是 0-1 归一化值，这里转成 0-255。
      return [color.r * 255, color.g * 255, color.b * 255]
    }
  }
  return undefined
}

/** 输入：主题色 + 回退 RGB；输出：hex 字符串。 */
export function themeHex(value: unknown, fallback: Rgb): string {
  return toHex(toRgb(value) ?? fallback)
}
