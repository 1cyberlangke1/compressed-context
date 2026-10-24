import type { Plugin } from "@opencode/plugin"

/** 宿主 session.metadata 的类型；写入是整体替换，读改写必须先合并。 */
type SessionMetadata = Awaited<ReturnType<Plugin.Context["session"]["get"]>>["metadata"]

/** 进程级会话 metadata 锁表；插件按 location 各加载一份，写入的却是同一条会话记录。 */
const CHAINS_KEY = Symbol.for("compressed-context.session-metadata")

function chains(): Map<string, Promise<void>> {
  const holder = globalThis as unknown as Record<symbol, Map<string, Promise<void>> | undefined>
  const existing = holder[CHAINS_KEY]
  if (existing !== undefined) return existing
  const created = new Map<string, Promise<void>>()
  holder[CHAINS_KEY] = created
  return created
}

/**
 * 输入：插件上下文 + sessionID + 合并函数。
 * 输出：无。
 * 预期：同一会话的 metadata 读改写串行执行。
 *       宿主 metadata 是整体替换语义，多个分支（统计、终止原因）并发时
 *       直接 get→update 会互相覆盖，这里用进程级锁把它们排成队列。
 */
export async function updateSessionMetadata(
  ctx: Plugin.Context,
  sessionID: string,
  merge: (current: SessionMetadata) => SessionMetadata,
): Promise<void> {
  const table = chains()
  const previous = table.get(sessionID) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => gate, () => gate)
  table.set(sessionID, tail)
  await previous.catch(() => undefined)
  try {
    const session = await ctx.session.get({ sessionID })
    await ctx.session.update({ sessionID, metadata: merge(session.metadata) })
  } finally {
    release()
    if (table.get(sessionID) === tail) table.delete(sessionID)
  }
}
