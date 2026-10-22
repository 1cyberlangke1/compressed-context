import type { Plugin } from "@opencode/plugin"

import { cacheHistoryKey } from "../shared/cache.ts"
import { forEachScannedEntry } from "../shared/scan.ts"
import { clearActiveSummary } from "./active-summary-cache.ts"
import { recordCacheHistory } from "./cache-history.ts"
import { deleteSessionTempFiles } from "./decompress.ts"
import { markSessionDeleted } from "./deleted-sessions.ts"
import { blockMarker } from "./render.ts"
import { deleteTranscriptsForSession } from "./transcript-store.ts"
import {
  STATE_PREFIX,
  commitPending,
  dropPending,
  loadState,
  parseState,
  retryPending,
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
 * 预期：只有最新 checkpoint 包含 pending marker 才转正；失败时保留 phase 让下一次请求重试，
 *       达到 MAX_COMPRESSION_ATTEMPTS 后清除 phase，记录真实原因。
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
  // 本层失败：保留 phase，下一次请求由 auto 重新入队；达到上限后 retryPending 会清掉 phase。
  if (state.phase !== undefined) {
    await saveState(ctx.storage, sessionID, retryPending(state, detail))
    return
  }
  // T1 没有下一层可重试：丢弃 pending，记录真实原因。
  await saveState(ctx.storage, sessionID, dropPending(state, detail))
}

export interface SessionEventOptions {
  readonly onSessionIdle?: (sessionID: string) => void
  readonly onSessionDeleted?: (sessionID: string) => void
  readonly onStepEnded?: (input: {
    readonly sessionID: string
    readonly messageID: string
    readonly tokens: {
      readonly input: number
      readonly output: number
      readonly reasoning: number
      readonly cache: { readonly read: number; readonly write: number }
    }
  }) => void | Promise<void>
}

/**
 * 输入：插件上下文 + sessionID。
 * 输出：无。
 * 预期：先打墓碑阻止迟到写入，再删 state、cache history、transcript 与临时文件。
 */
export async function forgetSession(ctx: Plugin.Context, sessionID: string): Promise<void> {
  markSessionDeleted(sessionID)
  clearActiveSummary(sessionID)
  deleteSessionTempFiles(sessionID)
  try {
    await Promise.all([
      ctx.storage.remove(stateKey(sessionID)),
      ctx.storage.remove(cacheHistoryKey(sessionID)),
      deleteTranscriptsForSession(ctx.storage, sessionID),
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
          case "session.step.ended": {
            const data = event.data as {
              sessionID: string
              assistantMessageID?: string
              tokens?: { input: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
            }
            const tokens = data.tokens
            if (tokens !== undefined && options.onStepEnded !== undefined) {
              await options.onStepEnded({
                sessionID: data.sessionID,
                messageID: data.assistantMessageID ?? "",
                tokens: {
                  input: tokens.input,
                  output: tokens.output ?? 0,
                  reasoning: tokens.reasoning ?? 0,
                  cache: { read: tokens.cache?.read ?? 0, write: tokens.cache?.write ?? 0 },
                },
              })
            }
            break
          }
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

/** 输入：任意错误；输出：是否明确的“会话不存在”。 */
function isSessionMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return /not found|404/i.test(String(error))
  }
  const record = error as Record<string, unknown>
  const status = record["status"] ?? record["statusCode"] ?? record["code"]
  if (status === 404 || status === "404" || status === "not_found") return true
  const message = typeof record["message"] === "string" ? record["message"] : ""
  return /not found|404/i.test(message)
}

/**
 * 输入：服务端上下文 + 每个 state 条目的处理函数。
 * 输出：无。
 * 预期：按 100 条一页顺序遍历所有 state key；空 sessionID 跳过，处理函数串行 await。
 */
async function forEachStateEntry(
  ctx: Plugin.Context,
  visit: (sessionID: string, value: unknown) => Promise<void>,
): Promise<void> {
  await forEachScannedEntry(ctx.storage, STATE_PREFIX, async (entry) => {
    const sessionID = entry.key.slice(STATE_PREFIX.length)
    if (sessionID.length === 0) return
    await visit(sessionID, entry.value)
  })
}

/**
 * 输入：服务端上下文。
 * 输出：无。
 * 预期：启动时只清理“明确不存在”会话的孤儿 state；瞬时错误不删数据。
 */
async function cleanupOrphanStates(ctx: Plugin.Context): Promise<void> {
  await forEachStateEntry(ctx, async (sessionID) => {
    try {
      await ctx.session.get({ sessionID })
    } catch (error) {
      if (isSessionMissing(error)) await forgetSession(ctx, sessionID)
    }
  })
}

/** 输入：服务端上下文；输出：无；预期：启动时对账所有 pending 状态并清理孤儿。 */
export async function reconcileAll(ctx: Plugin.Context): Promise<void> {
  try {
    await cleanupOrphanStates(ctx)
    await forEachStateEntry(ctx, async (sessionID, value) => {
      const state = parseState(value)
      if (!state.pending) return
      await saveState(ctx.storage, sessionID, await reconcile(ctx, sessionID, state))
    })
  } catch {
    // best effort
  }
}
