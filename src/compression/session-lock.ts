/**
 * 进程级会话锁。
 *
 * 输入：全局 Symbol（区分不同用途的锁表）+ sessionID + 任务。
 * 输出：任务结果。
 * 预期：同一锁表里的同一会话按入队顺序串行，不同会话并行；
 *       任务异常照常向上抛，不吞掉；锁表挂 `globalThis`，热重载与多 location 实例共享。
 */

/** 输入：Symbol；输出：该 Symbol 对应的会话锁表。预期：首次调用时创建，之后复用同一个 Map。 */
export function sessionChains(key: symbol): Map<string, Promise<void>> {
  const holder = globalThis as unknown as Record<symbol, Map<string, Promise<void>> | undefined>
  const existing = holder[key]
  if (existing !== undefined) return existing
  const created = new Map<string, Promise<void>>()
  holder[key] = created
  return created
}

/**
 * 输入：锁表 + 会话 ID + 要串行执行的任务。
 * 输出：任务返回值。
 * 预期：`previous` 理论上永不 reject，仍兜一层，避免坏任务把后续请求永久卡住；
 *       结束时只删自己入队的 tail。
 */
export async function withSessionLock<T>(
  tails: Map<string, Promise<void>>,
  sessionID: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(sessionID) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(
    () => gate,
    () => gate,
  )
  tails.set(sessionID, tail)
  await previous.catch(() => undefined)
  try {
    return await work()
  } finally {
    release()
    if (tails.get(sessionID) === tail) tails.delete(sessionID)
  }
}
