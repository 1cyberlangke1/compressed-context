/**
 * 已删除会话的内存墓碑。
 *
 * 输入：会话删除事件。
 * 输出：无。
 * 预期：删除后到达的 saveState / saveTranscript 直接跳过，避免把状态复活；
 *       进程重启后墓碑消失，由启动 GC 清理孤儿数据。
 */
const deleted = new Set<string>()

/** 输入：sessionID；输出：无；预期：标记会话已删除。 */
export function markSessionDeleted(sessionID: string): void {
  deleted.add(sessionID)
}

/** 输入：sessionID；输出：是否已删除。 */
export function isSessionDeleted(sessionID: string): boolean {
  return deleted.has(sessionID)
}

/** 输入：无；输出：无；预期：测试或多租户重置时清空墓碑。 */
export function clearDeletedSessions(): void {
  deleted.clear()
}
