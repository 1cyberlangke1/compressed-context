import type { Plugin } from "@opencode/plugin"

import { cacheHistoryKey } from "../shared/cache.ts"
import { recordCacheHistory } from "./cache-history.ts"
import { blockMarker } from "./render.ts"
import {
  STATE_PREFIX,
  commitPending,
  dropPending,
  loadState,
  parseState,
  saveState,
  stateKey,
  type State,
} from "./state.ts"

/** 输入：服务端上下文 + sessionID + 块 id；输出：最新 compaction 是否包含该块。 */
export async function hasBlockInLatestCompaction(
  ctx: Plugin.Context,
  sessionID: string,
  blockId: string,
): Promise<boolean> {
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

export type CompactionEventType = "ended" | "failed"

/** 摘要链仍超预算且没有任何合法合并候选时的终止提示。 */
export const TERMINAL_MESSAGE =
  "compression cannot reduce this context further: start a new session or use native compaction"

/**
 * 输入：服务端上下文 + 事件类型 + sessionID + 事件自带错误（仅 failed 有）。
 * 输出：无。
 * 预期：只有最新 checkpoint 包含 pending marker 才转正；失败丢弃 pending 和 phase，
 *       记录真实原因，不自动重试（网络与 JSON 重试已由 OpenCode / runSummaryPrompt 覆盖）。
 *       事件 error 优先于 state.lastError——钩子没跑过的失败（如 OpenCode 在钩子前判定
 *       「无可压缩内容」）state 里没有任何错误记录，只能从事件拿真实原因。
 */
export async function handleCompactionEvent(
  ctx: Plugin.Context,
  type: CompactionEventType,
  sessionID: string,
  eventError?: string,
): Promise<void> {
  const state = await loadState(ctx.storage, sessionID)
  if (type === "ended") {
    if (!state.pending) {
      await saveState(ctx.storage, sessionID, { ...state, attempts: 0 })
      return
    }
    // 事件可能晚到：只有最新 checkpoint 确实包含这个 pending 才转正，
    // 否则它属于下一层 compaction，留给下一次 ended。
    if (await hasBlockInLatestCompaction(ctx, sessionID, state.pending.id)) {
      await saveState(ctx.storage, sessionID, commitPending(state))
    }
    return
  }

  const detail = eventError ?? state.lastError ?? "compaction failed"
  // 钩子从未运行的失败（state 里没有任何本层错误记录）且已排下一层 phase：
  // 典型是历史里只剩 checkpoint，OpenCode 在钩子前就判定无可压缩内容。
  // 这不是本层失败，保留 phase 等下一次带真实消息的压缩，不计 attempts。
  if (eventError !== undefined && state.lastError === undefined && state.phase !== undefined) {
    await saveState(ctx.storage, sessionID, { ...state, attempts: 0 })
    return
  }
  // 不自动重试：丢弃 pending/phase，记录真实原因，交给下一次触发。
  await saveState(ctx.storage, sessionID, dropPending(state, detail))
}

export interface SessionEventOptions {
  readonly onSessionIdle?: (sessionID: string) => void
  readonly onSessionDeleted?: (sessionID: string) => void
}

/** 输入：插件上下文 + sessionID；输出：无；预期：删除该会话的压缩状态与缓存历史。 */
async function forgetSession(ctx: Plugin.Context, sessionID: string): Promise<void> {
  try {
    await Promise.all([
      ctx.storage.remove(stateKey(sessionID)),
      ctx.storage.remove(cacheHistoryKey(sessionID)),
    ])
  } catch {
    // best effort：删不掉也不影响当前进程
  }
}

/**
 * 输入：插件上下文 + 可选清理回调。
 * 输出：订阅会话事件并返回取消函数。
 * 预期：compaction 成功/失败对账 pending；usage.updated/idle 补写缓存历史；
 *       idle 清理内存；deleted 清理内存与 storage。
 */
export function startSessionEvents(
  ctx: Plugin.Context,
  options: SessionEventOptions = {},
): () => void {
  const controller = new AbortController()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        switch (event.type) {
          case "session.compaction.ended":
          case "session.compaction.failed": {
            const type: CompactionEventType =
              event.type === "session.compaction.ended" ? "ended" : "failed"
            const failure =
              event.type === "session.compaction.failed"
                ? ((event.data as { error?: { message?: string } }).error?.message ?? "compaction failed")
                : undefined
            await handleCompactionEvent(ctx, type, event.data.sessionID, failure)
            break
          }
          case "session.usage.updated":
          case "session.idle":
            // session.idle 在新版本里已标记 deprecated，usage.updated 每个 step 都会发；
            // 两个都接，谁先到都能补写（按 messageID 去重）。
            await recordCacheHistory(ctx, event.data.sessionID)
            if (event.type === "session.idle") options.onSessionIdle?.(event.data.sessionID)
            break
          case "session.deleted":
            await forgetSession(ctx, event.data.sessionID)
            options.onSessionDeleted?.(event.data.sessionID)
            break
        }
      }
    } catch {
      // aborted or disconnected；下一次事件或启动对账会补上
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
