/**
 * 压缩互斥注册表。
 *
 * 同一插件会按 location 加载多份实例；模块内的 Map 无法跨实例共享。
 * 这里把“正在执行 compaction”和“已发起但钩子还没接手”的状态挂到 `globalThis`
 * 的 Symbol 上，保证同一会话在进程内只入队一次压缩。
 */
interface Registry {
  /** 正在执行 compaction 钩子的会话和嵌套深度。 */
  readonly running: Map<string, number>
  /** 已调用 `session.compact`、钩子尚未接手的会话。 */
  readonly requested: Set<string>
}

const REGISTRY_KEY = Symbol.for("compressed-context.inflight")

/** 输入：无；输出：进程级共享注册表。预期：同一个进程只创建一次。 */
function registry(): Registry {
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>
  const existing = holder[REGISTRY_KEY]
  if (existing !== undefined) return existing
  const created: Registry = { running: new Map(), requested: new Set() }
  holder[REGISTRY_KEY] = created
  return created
}

/**
 * 输入：sessionID + 是否进入压缩。
 * 输出：无。
 * 预期：active=true 时深度 +1；false 时 -1，最后一个离开者才真正清除。
 */
export function markCompactionInFlight(sessionID: string, active: boolean): void {
  const running = registry().running
  if (active) {
    running.set(sessionID, (running.get(sessionID) ?? 0) + 1)
    return
  }
  const current = running.get(sessionID) ?? 0
  if (current <= 1) running.delete(sessionID)
  else running.set(sessionID, current - 1)
}

/** 输入：sessionID；输出：是否正在压缩。 */
export function isCompactionInFlight(sessionID: string): boolean {
  return (registry().running.get(sessionID) ?? 0) > 0
}

/**
 * 输入：sessionID；输出：本次是否抢到 compaction 钩子的执行权。
 * 预期：另一个实例已经在生成摘要时返回 false；抢到后必须调用 `endCompaction`。
 */
export function tryBeginCompaction(sessionID: string): boolean {
  const running = registry().running
  if ((running.get(sessionID) ?? 0) > 0) return false
  running.set(sessionID, 1)
  return true
}

/** 输入：sessionID；输出：无；预期：释放 `tryBeginCompaction` 抢到的执行权。 */
export function endCompaction(sessionID: string): void {
  registry().running.delete(sessionID)
}

/**
 * 输入：sessionID；输出：是否抢到本次 `session.compact` 的发起权。
 * 预期：另一个实例已经发起、钩子尚未接手时返回 false；抢到后必须释放。
 */
export function tryBeginCompactionRequest(sessionID: string): boolean {
  const requested = registry().requested
  if (requested.has(sessionID) || isCompactionInFlight(sessionID)) return false
  requested.add(sessionID)
  return true
}

/** 输入：sessionID；输出：无；预期：释放 `tryBeginCompactionRequest` 抢到的发起权。 */
export function endCompactionRequest(sessionID: string): void {
  registry().requested.delete(sessionID)
}
