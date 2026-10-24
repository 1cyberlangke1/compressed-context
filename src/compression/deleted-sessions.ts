/**
 * 已删除会话的内存墓碑。
 *
 * 输入：会话删除事件。
 * 输出：无。
 * 预期：删除后到达的 saveState / saveTranscript 直接跳过，避免把状态复活；
 *       进程重启后墓碑消失，由启动 GC 清理孤儿数据。
 */
const deleted = new Set<string>()

/** 墓碑上限。删除事件只影响清理时机，超过上限时淘汰最老的墓碑不会造成数据错误。 */
const MAX_DELETED_SESSIONS = 500

/**
 * 输入：sessionID。
 * 输出：无。
 * 预期：标记会话已删除；集合超过上限时按插入顺序淘汰最老的墓碑，避免进程长期运行后无限增长。
 */
export function markSessionDeleted(sessionID: string): void {
  deleted.add(sessionID)
  while (deleted.size > MAX_DELETED_SESSIONS) {
    const oldest = deleted.values().next()
    if (oldest.done === true) return
    deleted.delete(oldest.value)
  }
}

/** 输入：sessionID；输出：是否已删除。 */
export function isSessionDeleted(sessionID: string): boolean {
  return deleted.has(sessionID)
}

/** 输入：无；输出：无；预期：测试或多租户重置时清空墓碑。 */
export function clearDeletedSessions(): void {
  deleted.clear()
}
