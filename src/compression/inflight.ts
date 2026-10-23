/**
 * 正在执行 compaction 钩子的会话。
 *
 * 压缩钩子内部会调用 session.generate 生成摘要；那个请求同样会经过 context 钩子。
 * 如果其他写者不避让，就会在压缩过程中改 state，甚至再次入队压缩形成递归。
 *
 * 用计数而不是布尔值，避免嵌套标记提前清除。
 */
const depths = new Map<string, number>()

/**
 * 输入：sessionID + 是否进入压缩。
 * 输出：无。
 * 预期：active=true 时深度 +1；false 时 -1，最后一个离开者才真正清除。
 */
export function markCompactionInFlight(sessionID: string, active: boolean): void {
  if (active) {
    depths.set(sessionID, (depths.get(sessionID) ?? 0) + 1)
    return
  }
  const current = depths.get(sessionID) ?? 0
  if (current <= 1) depths.delete(sessionID)
  else depths.set(sessionID, current - 1)
}

/** 输入：sessionID；输出：是否正在压缩。 */
export function isCompactionInFlight(sessionID: string): boolean {
  return (depths.get(sessionID) ?? 0) > 0
}
