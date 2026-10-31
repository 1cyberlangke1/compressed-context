import type { Plugin } from "@opencode/plugin"

import { cacheHistoryKey } from "../shared/cache.ts"
import { sameLocation, type LocationLike } from "../shared/location.ts"
import { forEachScannedEntry } from "../shared/scan.ts"
import { clearActiveSummary } from "./active-summary-cache.ts"
import { recordCacheHistory } from "./cache-history.ts"
import { deleteSessionTempFiles } from "./decompress.ts"
import { markSessionDeleted } from "./deleted-sessions.ts"
import { blockMarker } from "./render.ts"
import {
  effectiveWindowKey,
  effectiveWindowModelKey,
  resolvedWindowKey,
} from "./settings.ts"
import { deleteTranscriptsForSession } from "./transcript-store.ts"
import { measuredPromptTokens } from "./auto.ts"
import { isCompactionInFlight } from "./inflight.ts"
import {
  STATE_PREFIX,
  commitPending,
  dropPending,
  retryPending,
  stateKey,
  type State,
} from "./state.ts"
import { stateStore } from "./state-store.ts"

/** 输入：服务端上下文 + sessionID + 块 id；输出：最新 compaction 是否包含该块。 */
export async function hasBlockInLatestCompaction(
  ctx: Plugin.Context,
  sessionID: string,
  blockId: string,
): Promise<boolean> {
  try {
    const messages = await ctx.session.context({ sessionID })
    // 必须取「最后一条」completed compaction：历史里可能有多条，pending 的标记只在最新那条里。
    let latestSummary: string | undefined
    for (const message of messages) {
      if (message.type === "compaction" && message.status === "completed") latestSummary = message.summary
    }
    if (latestSummary === undefined) return false
    return latestSummary.includes(blockMarker(blockId))
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

/**
 * 输入：服务端上下文 + 事件类型 + sessionID + 事件自带错误（仅 failed 有）。
 * 输出：无。
 * 预期：只有最新 checkpoint 包含 pending marker 才转正；失败时保留 phase 让下一次请求重试。
 *       事件 error 优先于 state.lastError——钩子没跑过的失败（如 OpenCode 在钩子前判定
 *       「无可压缩内容」）state 里没有任何错误记录，只能从事件拿真实原因。
 */
export async function handleCompactionEvent(
  ctx: Plugin.Context,
  type: CompactionEventType,
  sessionID: string,
  eventError?: string,
): Promise<void> {
  await stateStore(ctx.storage).transact(sessionID, async (state) => {
    if (type === "ended") {
      if (!state.pending) {
        return { next: { ...state, attempts: 0 }, result: undefined }
      }
      // 事件可能晚到：只有最新 checkpoint 确实包含这个 pending 才转正，
      // 否则它属于下一层 compaction，留给下一次 ended。
      if (await hasBlockInLatestCompaction(ctx, sessionID, state.pending.id)) {
        const committed = commitPending(state)
        // 压缩成功后把提醒基线重置到最近一次真实 usage；否则基线会停留在压缩前的旧值。
        const baseline = await measuredPromptTokens(ctx, sessionID)
        return {
          next: baseline === undefined ? committed : { ...committed, nudgeBaselineTokens: baseline },
          result: undefined,
        }
      }
      return { result: undefined }
    }

    const detail = eventError ?? state.lastError ?? "compaction failed"
    // 「没有可压缩内容」不是本层失败：说明已经压干净了（或钩子前就没东西可压）。
    // 把它计进 attempts / lastError 会在链尾留下一条假失败，掩盖真实错误。
    if (/nothing to compact/i.test(detail)) {
      return {
        next: state.pending === undefined ? { ...state, attempts: 0 } : state,
        result: undefined,
      }
    }
    // 用户打断（session.interrupt）是假失败：宿主把 compact fiber 标记 interrupted，
    // 但钩子里的摘要请求可能仍在跑并随后 save(pending)。此时清 pending 会和钩子的
    // save 竞态，最终留下「pending 在场 + lastError 丢失」的悬空状态，把 auto 卡死在
    // blockedByState 上（复现见 scripts/e2e-repro-interrupt.mjs）。
    // 钩子已收尾（非 in-flight）且 pending 在场：摘要确实产出落盘了（钩子 save 在
    // endCompaction 之前），直接转正——宁可摘要重复展示，也不让会话卡死。
    if (/interrupted|aborted|cancelled/i.test(detail)) {
      if (state.pending !== undefined && !isCompactionInFlight(sessionID)) {
        return { next: commitPending(state), result: undefined }
      }
      return { result: undefined }
    }
    // 钩子从未运行的失败（state 里没有任何本层错误记录）且已排下一层 phase：
    // 典型是历史里只剩 checkpoint，OpenCode 在钩子前就判定无可压缩内容。
    // 这不是本层失败，保留 phase 等下一次带真实消息的压缩，不计 attempts。
    if (eventError !== undefined && state.lastError === undefined && state.phase !== undefined) {
      return { next: { ...state, attempts: 0 }, result: undefined }
    }
    // 本层失败：保留 phase，下一次请求由 auto 重新入队；达到上限后 retryPending 会清掉 phase。
    if (state.phase !== undefined) {
      return { next: retryPending(state, detail), result: undefined }
    }
    // T1 没有下一层可重试：丢弃 pending，记录真实原因。
    return { next: dropPending(state, detail), result: undefined }
  })
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
 * 预期：先打墓碑阻止迟到写入，再删 state、cache history、transcript、
 *       该会话的窗口解析缓存（原生 / 生效 / 生效模型）与临时文件。
 */
export async function forgetSession(ctx: Plugin.Context, sessionID: string): Promise<void> {
  markSessionDeleted(sessionID)
  clearActiveSummary(sessionID)
  deleteSessionTempFiles(sessionID)
  try {
    await Promise.all([
      ctx.storage.remove(stateKey(sessionID)),
      ctx.storage.remove(cacheHistoryKey(sessionID)),
      ctx.storage.remove(resolvedWindowKey(sessionID)),
      ctx.storage.remove(effectiveWindowKey(sessionID)),
      ctx.storage.remove(effectiveWindowModelKey(sessionID)),
      deleteTranscriptsForSession(ctx.storage, sessionID),
    ])
  } catch {
    // best effort：删不掉也不影响当前进程
  }
}

/** 输入：事件里未校验的 location 字段；输出：可比较的 location，形状不对时 undefined。 */
function readLocation(value: unknown): LocationLike | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const directory = record["directory"]
  if (typeof directory !== "string") return undefined
  const workspaceID = record["workspaceID"]
  if (workspaceID !== undefined && typeof workspaceID !== "string") return undefined
  return { directory, workspaceID }
}

/** 输入：事件里未校验的 tokens 字段；输出：规范化后的 usage，形状不对时 undefined。 */
function readStepTokens(raw: unknown): {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
} | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const input = record["input"]
  if (typeof input !== "number" || !Number.isFinite(input)) return undefined
  const finite = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0)
  const cache =
    typeof record["cache"] === "object" && record["cache"] !== null
      ? (record["cache"] as Record<string, unknown>)
      : {}
  return {
    input,
    output: finite(record["output"]),
    reasoning: finite(record["reasoning"]),
    cache: { read: finite(cache["read"]), write: finite(cache["write"]) },
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
  // 本实例确认过归属的会话。session.deleted 之后已经查不到会话，
  // 只能靠这份集合判断“这条删除事件是不是我负责清理的”。
  const owned = new Set<string>()
  // 已通过 session.moved 明确迁走的会话；宿主查询可能晚于事件更新，不能再从 get 结果重新认领。
  const disowned = new Set<string>()

  /**
   * 输入：sessionID。
   * 输出：会话是否属于本实例 location。
   * 预期：查询失败或查不到一律视为不属于——宁可漏记一次，也不能跨 location 重复记账。
   */
  const owns = async (sessionID: string): Promise<boolean> => {
    if (owned.has(sessionID)) return true
    if (disowned.has(sessionID)) return false
    const session = await ctx.session.get({ sessionID }).catch(() => undefined)
    if (!sameLocation(session?.location, ctx.location)) return false
    owned.add(sessionID)
    return true
  }

  /** 输入：单条事件；输出：无；预期：处理一条事件，异常由外层兜住，不影响后续事件。 */
  const handleEvent = async (event: {
    readonly type: string
    readonly data: unknown
    readonly location?: unknown
  }): Promise<void> => {
    switch (event.type) {
      case "session.step.ended": {
        const data = event.data as {
          sessionID: string
          assistantMessageID?: string
          tokens?: unknown
        }
        // 没有 messageID 的样本无法去重，写进去会和其它空串样本互相吞掉。
        const messageID = data.assistantMessageID
        if (typeof messageID !== "string" || messageID.length === 0) return
        const tokens = readStepTokens(data.tokens)
        if (tokens === undefined || options.onStepEnded === undefined) return
        if (!(await owns(data.sessionID))) return
        await options.onStepEnded({ sessionID: data.sessionID, messageID, tokens })
        return
      }
      case "session.compaction.ended":
      case "session.compaction.failed": {
        const data = event.data as { sessionID: string; error?: { message?: string } }
        if (!(await owns(data.sessionID))) return
        const type: CompactionEventType = event.type === "session.compaction.ended" ? "ended" : "failed"
        const failure =
          event.type === "session.compaction.failed"
            ? (data.error?.message ?? "compaction failed")
            : undefined
        await handleCompactionEvent(ctx, type, data.sessionID, failure)
        return
      }
      case "session.usage.updated":
      case "session.idle": {
        const data = event.data as { sessionID: string }
        if (!(await owns(data.sessionID))) return
        // session.idle 在新版本里已标记 deprecated，usage.updated 每个 step 都会发；
        // 两个都接，谁先到都能补写（按 messageID 去重）。
        await recordCacheHistory(ctx, data.sessionID)
        if (event.type === "session.idle") options.onSessionIdle?.(data.sessionID)
        return
      }
      case "session.execution.succeeded": {
        // 2.1.x 起 session.idle 是 ephemeral，到不了插件；真正表示“这一轮跑完了”的是
        // execution.succeeded。这里只做内存清理，不重复写缓存历史。
        const data = event.data as { sessionID: string }
        if (!(await owns(data.sessionID))) return
        options.onSessionIdle?.(data.sessionID)
        return
      }
      case "session.moved": {
        const data = event.data as { sessionID: string; location?: unknown }
        // 移动事件同时投给旧 location 与新 location 的实例：先让旧归属立即失效。
        owned.delete(data.sessionID)
        // payload 的 data.location 是真实目的地；信封 location 是源 location，不能拿来兜底。
        // 读不到目的地说明载荷缺失/损坏，按已迁走处理，宁可漏记也不能把旧会话重新认领。
        const destination = readLocation(data.location)
        if (sameLocation(destination, ctx.location)) {
          disowned.delete(data.sessionID)
          owned.add(data.sessionID)
        } else {
          disowned.add(data.sessionID)
        }
        return
      }
      case "session.deleted": {
        const data = event.data as { sessionID: string }
        // 删除是全局事实：事件通常带 location，但不能据此只清一个实例；
        // 本实例可能通过钩子/工具写过 state 却没进 owned。
        // 因此不按 owned 过滤：统一打墓碑并清理（存储 key 全局共享，重复删除无害），
        // 否则在途压缩收尾会把刚删掉的会话写回来。
        owned.delete(data.sessionID)
        disowned.delete(data.sessionID)
        await forgetSession(ctx, data.sessionID)
        options.onSessionDeleted?.(data.sessionID)
        return
      }
    }
  }

  /** 输入：事件里未校验的载荷；输出：会话 ID；缺失或形状不对时 undefined。 */
  const readSessionID = (raw: unknown): string | undefined => {
    if (typeof raw !== "object" || raw === null) return undefined
    const value = (raw as Record<string, unknown>)["sessionID"]
    return typeof value === "string" && value.length > 0 ? value : undefined
  }

  /** 每个会话的串行队列；同一会话按到达顺序处理，不同会话互不阻塞。 */
  const chains = new Map<string, Promise<void>>()

  /**
   * 输入：sessionID + 处理任务。
   * 输出：无。
   * 预期：任务挂到该会话队尾；完成后删除空队列。
   *       慢任务（压缩对账要读 session.context）不再拖住其它会话的记账。
   */
  const enqueue = (sessionID: string, task: () => Promise<void>): void => {
    const previous = chains.get(sessionID) ?? Promise.resolve()
    const next: Promise<void> = previous
      .then(task)
      .catch(() => {
        // 单条事件失败不能让订阅退出：事件流没有重放，退出就再也不会收到后续事件。
      })
      .finally(() => {
        if (chains.get(sessionID) === next) chains.delete(sessionID)
      })
    chains.set(sessionID, next)
  }

  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const sessionID = readSessionID(event.data)
        if (sessionID === undefined) continue
        enqueue(sessionID, () => handleEvent(event))
      }
    } catch {
      // aborted or disconnected；下一次事件或启动对账会补上
    }
  })()
  return () => {
    controller.abort()
  }
}

/**
 * 输入：任意错误。
 * 输出：是否明确的“会话不存在”。
 * 预期：只认结构化标记（TaggedError `_tag` 或 HTTP 404），
 *       不再用错误文案正则——文案里带 "not found" 的瞬时错误会误删会话数据。
 */
function isSessionMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const record = error as Record<string, unknown>
  if (record["_tag"] === "Session.NotFoundError") return true
  const status = record["status"] ?? record["statusCode"] ?? record["code"]
  return status === 404 || status === "404" || status === "not_found"
}

/**
 * 输入：服务端上下文 + 每个 state 条目的处理函数。
 * 输出：无。
 * 预期：按 100 条一页顺序遍历所有 state key；空 sessionID 跳过，处理函数串行 await。
 */
async function forEachStateEntry(
  ctx: Plugin.Context,
  visit: (sessionID: string) => Promise<void>,
): Promise<void> {
  await forEachScannedEntry(ctx.storage, STATE_PREFIX, async (entry) => {
    const sessionID = entry.key.slice(STATE_PREFIX.length)
    if (sessionID.length === 0) return
    await visit(sessionID)
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

/**
 * 输入：服务端上下文。
 * 输出：无。
 * 预期：启动时清理孤儿，并只对账「属于本实例 location」的 pending；
 *       storage 按插件全局共享，查询不到或查询失败一律跳过，宁可少记不可重复。
 */
export async function reconcileAll(ctx: Plugin.Context): Promise<void> {
  try {
    await cleanupOrphanStates(ctx)
    await forEachStateEntry(ctx, async (sessionID) => {
      // 压缩钩子自己会写 state；启动对账跳过它，避免把正在生成的 pending 丢掉。
      if (isCompactionInFlight(sessionID)) return
      // 对账会改写 pending；必须确认会话属于本实例，否则会替别的 location 丢掉 pending。
      const session = await ctx.session.get({ sessionID }).catch(() => undefined)
      if (!sameLocation(session?.location, ctx.location)) return
      await stateStore(ctx.storage).transact(sessionID, async (state) => {
        // 拿到锁后再确认一次：压缩钩子可能刚好在这两步之间启动。
        if (isCompactionInFlight(sessionID)) return { result: undefined }
        if (!state.pending) return { result: undefined }
        return { next: await reconcile(ctx, sessionID, state), result: undefined }
      })
    })
  } catch {
    // best effort
  }
}
