/** 输入：任意值 + 范围；输出：合法整数；非法返回 fallback。 */
export function readInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  const rounded = Math.round(value)
  if (rounded < min || rounded > max) return fallback
  return rounded
}

/** 输入：任意值 + 范围；输出：合法整数；非法返回 undefined。 */
export function readOptionalInt(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  const rounded = Math.round(value)
  if (rounded < min || rounded > max) return undefined
  return rounded
}

/**
 * 输入：任意值 + 默认值。
 * 输出：布尔；缺省返回 fallback，类型不对返回 undefined。
 * 预期：服务端设置对错误类型严格拒绝；TUI 迁移用宽松版本。
 */
export function readStrictBoolean(value: unknown, fallback: boolean): boolean | undefined {
  if (value === undefined) return fallback
  return typeof value === "boolean" ? value : undefined
}
