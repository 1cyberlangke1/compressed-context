/**
 * 面板数字格式化。
 *
 * 输入：token 数量（非负整数）。
 * 输出：紧凑字符串：<1000 原样、<10000 一位小数 k、<1e6 取整 k、
 *       <1e7 一位小数 M、更大取整 M。
 * 预期：侧栏一行内放得下，和 ACP 面板的显示口径一致。
 */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0"
  if (count < 1_000) return count.toString()
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`
  if (count < 1_000_000) return `${Math.round(count / 1_000).toString()}k`
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  return `${Math.round(count / 1_000_000).toString()}M`
}
