/**
 * 缓存突变的进程内状态：保存每个会话最近一次「发给上游的原始请求」。
 *
 * 「上一个请求」的判定必须按 assistant messageID 对齐，不能按时间、也不能按
 * 缓存历史数组里的相邻位置：重试、失败、原生压缩都会让时间顺序和 step 顺序错位。
 * 规则：
 * 1. `http.request` 只抓 `kind=primary` 的请求体；同一 step 重试时后一次覆盖前一次。
 * 2. `step.ended` 时把抓到的请求消费掉，并记下它对应的 messageID。
 * 3. 只有「上一条样本的 messageID == 上一次消费的 messageID」时才做前缀对比；
 *    对不上就记 `unknown`，绝不拿两条不相邻的报文硬比。
 */

import type { CacheSample } from "../shared/cache.ts"
import {
  diffRequests,
  dropPercent,
  outlineFromBody,
  requestPreview,
  type CacheDrop,
  type CacheRequestKind,
  type RequestDiff,
} from "../shared/cache-drops.ts"

/** 抓到的上游原始请求；messageID 要等 usage 才能确定。 */
export interface CapturedRequest {
  readonly body: string
  readonly at: number
  readonly kind: CacheRequestKind
}

/** 已消费的请求：补上它对应的 assistant messageID。 */
export interface ConsumedRequest extends CapturedRequest {
  readonly messageID: string
}

/** 一次 step.ended 能拿到的两段报文；缺哪边就说明对不上。 */
export interface RequestPair {
  readonly current?: CapturedRequest
  readonly previous?: ConsumedRequest
}

/** 会话级请求追踪器；生产环境挂 globalThis，测试可独立创建。 */
export interface DropTracker {
  /** 输入：sessionID + 原始请求；输出：无；预期：同会话覆盖，超过上限直接丢弃。 */
  capture(sessionID: string, request: CapturedRequest): void
  /** 输入：sessionID + 本条 messageID；输出：本轮与上一轮报文，并推进内部状态。 */
  consume(sessionID: string, messageID: string): RequestPair
  /** 输入：sessionID；输出：无；预期：删会话或关闭功能时清掉全部状态。 */
  forget(sessionID: string): void
  /** 输出：当前持有状态的会话数；用于测试与排障。 */
  size(): number
}

/** 单份请求体上限；超过就不留了，避免 1M 上下文把内存吃穿。 */
export const MAX_BODY_CHARS = 8 * 1024 * 1024

/** 输入：无；输出：新的独立追踪器。预期：测试用，生产走 `dropTracker()`。 */
export function createDropTracker(): DropTracker {
  const pending = new Map<string, CapturedRequest>()
  const previous = new Map<string, ConsumedRequest>()
  return {
    capture(sessionID, request) {
      if (request.body.length > MAX_BODY_CHARS) {
        pending.delete(sessionID)
        return
      }
      pending.set(sessionID, request)
    },
    consume(sessionID, messageID) {
      const current = pending.get(sessionID)
      pending.delete(sessionID)
      const prev = previous.get(sessionID)
      // 即使本轮没抓到报文，也只在抓到时才推进 previous，避免用两条不相邻的报文对比。
      if (current !== undefined) previous.set(sessionID, { ...current, messageID })
      return {
        ...(current === undefined ? {} : { current }),
        ...(prev === undefined ? {} : { previous: prev }),
      }
    },
    forget(sessionID) {
      pending.delete(sessionID)
      previous.delete(sessionID)
    },
    size() {
      return pending.size + previous.size
    },
  }
}

/** 进程级追踪器；热重载与多 location 实例共用一份，避免切实例后丢「上一个」。 */
const TRACKER_KEY = Symbol.for("compressed-context.drop-tracker")

/** 输入：无；输出：进程级追踪器。预期：首次调用创建，之后复用。 */
export function dropTracker(): DropTracker {
  const holder = globalThis as unknown as Record<symbol, DropTracker | undefined>
  const existing = holder[TRACKER_KEY]
  if (existing !== undefined) return existing
  const created = createDropTracker()
  holder[TRACKER_KEY] = created
  return created
}

/**
 * 输入：上一条样本 + 本条样本 + 报文对 + 阈值 + 本次请求类型。
 * 输出：达到阈值时返回记录；否则 undefined。
 * 预期：跌幅按百分点比较，只记下降；报文对不上时记 `unknown`，不猜断点。
 */
export function planCacheDrop(input: {
  readonly previousSample: CacheSample
  readonly sample: CacheSample
  readonly pair: RequestPair
  readonly kind: CacheRequestKind
  readonly model?: string
  readonly threshold: number
}): CacheDrop | undefined {
  const dropPp = dropPercent(input.previousSample.hitRate, input.sample.hitRate)
  if (dropPp < input.threshold) return undefined
  const diff = comparePair(input.pair, input.previousSample.messageID)
  return {
    messageID: input.sample.messageID,
    at: input.sample.at,
    kind: input.kind,
    ...(input.model === undefined ? {} : { model: input.model }),
    prevMessageID: input.previousSample.messageID,
    prompt: input.sample.input,
    hit: input.sample.cached,
    hitRate: input.sample.hitRate,
    prevPrompt: input.previousSample.input,
    prevHit: input.previousSample.cached,
    prevHitRate: input.previousSample.hitRate,
    dropPp,
    cause: diff.cause,
    ...(diff.breakPoint === undefined ? {} : { breakPoint: diff.breakPoint }),
    ...(diff.outline.length === 0 ? {} : { outline: diff.outline }),
    ...(diff.request === undefined ? {} : { request: diff.request }),
  }
}

/**
 * 输入：报文对 + 上一条样本的 messageID。
 * 输出：同一种请求类型的相邻两轮才做前缀对比；否则记 unknown。
 * 预期：unknown 时仍保留当前请求的结构轮廓与原文预览，便于面板展示「原始请求」。
 */
function comparePair(pair: RequestPair, previousMessageID: string): RequestDiff {
  const current = pair.current
  if (current === undefined) return { cause: "unknown", outline: [] }
  const previous = pair.previous
  if (previous === undefined) {
    return { cause: "unknown", outline: outlineFromBody(current.body), request: requestPreview(current.body) }
  }
  if (previous.kind !== current.kind || previous.messageID !== previousMessageID) {
    return { cause: "unknown", outline: outlineFromBody(current.body), request: requestPreview(current.body) }
  }
  return diffRequests(previous.body, current.body)
}
