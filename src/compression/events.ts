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

/** 压缩失败最多重试次数；超过后才丢弃 pending/phase。 */
export const MAX_COMPACTION_ATTEMPTS = 3

/**
 * 输入：错误文本。
 * 输出：是否是重试也不会变的永久错误。
 * 预期：空历史、内容不足、缺 id、摘要校验失败不重试。
 */
export function isPermanentFailure(error: string): boolean {
  return /nothing to compress|not enough content|messages are missing ids|empty field|summary too (short|long)|not smaller than the source/.test(
    error,
  )
}

/**
 * 输入：失败时的状态 + 错误。
 * 输出：下一次状态 + 是否继续重试。
 * 预期：未到上限时保留 pending/phase 并累加 attempts；到上限才丢弃。
 */
export function retryState(state: State, error: string): { readonly state: State; readonly retry: boolean } {
  const attempts = state.attempts + 1
  if (attempts >= MAX_COMPACTION_ATTEMPTS) {
    return {
      state: { ...dropPending(state, `${error} (after ${attempts.toString()} attempts)`), attempts },
      retry: false,
    }
  }
  return {
    state: {
      v: 1,
      blocks: state.blocks,
      attempts,
      ...(state.pending === undefined ? {} : { pending: state.pending }),
      ...(state.phase === undefined ? {} : { phase: state.phase }),
      lastError: error,
    },
    retry: true,
  }
}

/**
 * 输入：服务端上下文 + 事件类型 + sessionID + 事件自带错误（仅 failed 有）。
 * 输出：无。
 * 预期：只有最新 checkpoint 包含 pending marker 才转正；失败丢弃 pending 和 phase。
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
  // 典型是 enqueueNext 入队的空压缩——历史只剩 checkpoint，OpenCode 在钩子前就
  // 判定无可压缩内容。T2/T3 合并不需要新消息，这不是本层失败，保留 phase 等
  // 下一次带真实消息的压缩，不计 attempts。
  if (eventError !== undefined && state.lastError === undefined && state.phase !== undefined) {
    await saveState(ctx.storage, sessionID, { ...state, attempts: 0 })
    return
  }
  if (isPermanentFailure(detail)) {
    await saveState(ctx.storage, sessionID, dropPending(state, detail))
    return
  }
  const next = retryState(state, detail)
  await saveState(ctx.storage, sessionID, next.state)
  if (!next.retry) return
  // 失败后保留 pending/phase，稍等 inbox 行清掉再重新入队。
  setTimeout(() => {
    void ctx.session.compact({ sessionID, delivery: "steer" }).catch(() => undefined)
  }, 100)
}

/**
 * 输入：服务端上下文 + 可选的成功回调。
 * 输出：订阅 compaction.ended / compaction.failed，并返回取消函数。
 * 预期：成功时 pending 转正并回调；失败时丢弃 pending。
 */
export function startCompactionEvents(
  ctx: Plugin.Context,
  onCommitted?: (sessionID: string) => void,
): () => void {
  const controller = new AbortController()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (
          event.type !== "session.compaction.ended" &&
          event.type !== "session.compaction.failed" &&
          event.type !== "session.idle"
        ) {
          continue
        }
        if (event.type === "session.idle") {
          onCommitted?.(event.data.sessionID)
          continue
        }
        const type: CompactionEventType = event.type === "session.compaction.ended" ? "ended" : "failed"
        const sessionID = event.data.sessionID
        // failed 事件自带真实错误（钩子没跑时 state.lastError 是空的，只能从事件拿）
        const failure =
          event.type === "session.compaction.failed"
            ? ((event.data as { error?: { message?: string } }).error?.message ?? "compaction failed")
            : undefined
        await handleCompactionEvent(ctx, type, sessionID, failure)
        if (type === "ended") onCommitted?.(sessionID)
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
