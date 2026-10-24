import type { Plugin } from "@opencode/plugin"

import { sessionChains, withSessionLock } from "./session-lock.ts"

/** 宿主 session.metadata 的类型；写入是整体替换，读改写必须先合并。 */
type SessionMetadata = Awaited<ReturnType<Plugin.Context["session"]["get"]>>["metadata"]

/** 进程级会话 metadata 锁表；插件按 location 各加载一份，写入的却是同一条会话记录。 */
const CHAINS_KEY = Symbol.for("compressed-context.session-metadata")

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
  await withSessionLock(sessionChains(CHAINS_KEY), sessionID, async () => {
    const session = await ctx.session.get({ sessionID })
    await ctx.session.update({ sessionID, metadata: merge(session.metadata) })
  })
}
