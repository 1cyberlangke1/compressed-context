import type { Plugin } from "@opencode/plugin"

import { blockMarker } from "./render.ts"
import {
  STATE_PREFIX,
  commitPending,
  dropPending,
  loadState,
  parseState,
  saveState,
  type State,
} from "./state.ts"

/** 输入：服务端上下文 + sessionID + 块 id；输出：最新 compaction 是否包含该块。 */
async function hasBlockInLatestCompaction(ctx: Plugin.Context, sessionID: string, blockId: string): Promise<boolean> {
  try {
    const messages = await ctx.session.context({ sessionID })
    const latest = messages.find((message) => message.type === "compaction" && message.status === "completed")
    if (latest === undefined) return false
    return latest.summary.includes(blockMarker(blockId))
  } catch {
    return false
  }
}

/** 输入：状态；输出：pending 对账后的状态。 */
async function reconcile(ctx: Plugin.Context, sessionID: string, state: State): Promise<State> {
  if (!state.pending) return state
  const found = await hasBlockInLatestCompaction(ctx, sessionID, state.pending.id)
  return found ? commitPending(state) : dropPending(state, "pending compaction not found after restart")
}

/**
 * 输入：服务端上下文。
 * 输出：订阅 compaction.ended / compaction.failed，并返回取消函数。
 * 预期：成功时 pending 转正；失败时丢弃 pending。
 */
export function startCompactionEvents(ctx: Plugin.Context): () => void {
  const controller = new AbortController()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type !== "session.compaction.ended" && event.type !== "session.compaction.failed") continue
        const sessionID = event.data.sessionID
        const state = await loadState(ctx.storage, sessionID)
        if (!state.pending) continue
        if (event.type === "session.compaction.ended") {
          // 事件可能晚到：只有最新 checkpoint 确实包含这个 pending 才转正，
          // 否则它属于下一层 compaction，留给下一次 ended。
          if (await hasBlockInLatestCompaction(ctx, sessionID, state.pending.id)) {
            await saveState(ctx.storage, sessionID, commitPending(state))
          }
        } else {
          await saveState(ctx.storage, sessionID, dropPending(state, "compaction failed"))
        }
      }
    } catch {
      // aborted or disconnected; reconciliation on next startup covers it
    }
  })()
  return () => {
    controller.abort()
  }
}

/** 输入：服务端上下文；输出：无；预期：启动时对账所有 pending 状态。 */
export async function reconcileAll(ctx: Plugin.Context): Promise<void> {
  try {
    let after: string | undefined
    for (;;) {
      const options = after === undefined ? { prefix: STATE_PREFIX, limit: 100 } : { prefix: STATE_PREFIX, after, limit: 100 }
      const page = await ctx.storage.scan(options)
      for (const entry of page.entries) {
        const sessionID = entry.key.slice(STATE_PREFIX.length)
        const state = parseState(entry.value)
        if (!state.pending) continue
        await saveState(ctx.storage, sessionID, await reconcile(ctx, sessionID, state))
      }
      if (page.next === undefined) return
      after = page.next
    }
  } catch {
    // best effort
  }
}
