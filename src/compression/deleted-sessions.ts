/**
 * 已删除会话的内存墓碑。
 *
 * 输入：会话删除事件。
 * 输出：无。
 * 预期：删除后到达的 saveState / saveTranscript 直接跳过，避免把状态复活；
 *       进程重启后墓碑消失，由启动 GC 清理孤儿数据。
 */
const deleted = new Map<string, number>()

/** 墓碑上限：超过后按插入顺序淘汰最老的。 */
const MAX_DELETED_SESSIONS = 5_000

/** 墓碑保留时长：要长于最长一次压缩等待（5 分钟），否则迟到的写入会把会话复活。 */
const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 输入：sessionID。
 * 输出：无。
 * 预期：标记会话已删除；先清掉过期的墓碑，再按上限淘汰最老的，避免集合无限增长。
 */
export function markSessionDeleted(sessionID: string): void {
  const now = Date.now()
  for (const [id, at] of deleted) {
    if (now - at > TOMBSTONE_TTL_MS) deleted.delete(id)
  }
  deleted.delete(sessionID)
  deleted.set(sessionID, now)
  while (deleted.size > MAX_DELETED_SESSIONS) {
    const oldest = deleted.keys().next()
    if (oldest.done === true) return
    deleted.delete(oldest.value)
  }
}

/** 输入：sessionID；输出：是否已删除。预期：过期墓碑自动失效。 */
export function isSessionDeleted(sessionID: string): boolean {
  const at = deleted.get(sessionID)
  if (at === undefined) return false
  if (Date.now() - at > TOMBSTONE_TTL_MS) {
    deleted.delete(sessionID)
    return false
  }
  return true
}

/** 输入：无；输出：无；预期：测试或多租户重置时清空墓碑。 */
export function clearDeletedSessions(): void {
  deleted.clear()
}
