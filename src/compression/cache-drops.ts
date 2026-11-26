/**
 * 缓存突变的进程内状态：保存每个会话最近一次「发给上游的原始请求」。
 *
 * 「上一个请求」的判定：只要有上一份抓到的报文就直接对比，不要求 messageID
 * 对齐、也不要求请求类型相同——总有一次请求可以对照，面板要能指出到底哪一段变了。
 * 规则：
 * 1. `http.request` 抓所有非子代理请求的请求体；同一 step 重试时后一次覆盖前一次。
 * 2. `step.ended` / usage 已知时把抓到的请求消费掉，并记下它对应的 ID。
 * 3. 对比对象是「上一次消费的那份报文」，而不是缓存样本数组里的相邻位置。
 *    没有上一份报文时才记 `unknown`，但仍保存当前请求的结构与原文。
 */

import type { CacheSample } from "../shared/cache.ts"
import {
  diffRequests,
  dropPercent,
  outlineFromBody,
  requestPreview,
  treeFromBody,
  type CacheDrop,
  type CacheRequestKind,
  type RequestDiff,
} from "../shared/cache-drops.ts"

/** 抓到的上游原始请求；messageID 要等 usage 才能确定。 */
export interface CapturedRequest {
  readonly body: string
  readonly at: number
  readonly kind: CacheRequestKind
  /** `providerID/modelID`；用于面板显示这次请求是哪个模型发的。 */
  readonly model?: string
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
  /** 输入：sessionID + 原始请求；输出：无；预期：同会话覆盖，超过上限只留开头预览。 */
  capture(sessionID: string, request: CapturedRequest): void
  /** 输入：sessionID + 本条 messageID；输出：本轮与上一轮报文，并推进内部状态。 */
  consume(sessionID: string, messageID: string): RequestPair
  /** 输入：sessionID；输出：无；预期：丢弃没等到 usage 的 pending，保留上一份报文继续跨回合对比。 */
  clearPending(sessionID: string): void
  /** 输入：sessionID；输出：无；预期：删会话或关闭功能时清掉全部状态。 */
  forget(sessionID: string): void
  /** 输出：当前持有状态的会话数；用于测试与排障。 */
  size(): number
}

/** 输入：无；输出：新的独立追踪器。预期：测试用，生产走 `dropTracker()`。 */
export function createDropTracker(): DropTracker {
  const pending = new Map<string, CapturedRequest>()
  const previous = new Map<string, ConsumedRequest>()
  return {
    capture(sessionID, request) {
      pending.set(sessionID, request)
    },
    consume(sessionID, messageID) {
      const current = pending.get(sessionID)
      pending.delete(sessionID)
      const prev = previous.get(sessionID)
      // 只在抓到报文时推进 previous，避免把「没抓到的空轮」当成新基准。
      if (current !== undefined) previous.set(sessionID, { ...current, messageID })
      return {
        ...(current === undefined ? {} : { current }),
        ...(prev === undefined ? {} : { previous: prev }),
      }
    },
    clearPending(sessionID) {
      pending.delete(sessionID)
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
 * 预期：跌幅按百分点比较，只记下降；有上一份报文就强制对比，没有才记 `unknown`。
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
  const diff = comparePair(input.pair)
  // primary 请求没有单独的模型参数：从抓到的报文元数据里取。
  const model = input.model ?? input.pair.current?.model
  return {
    messageID: input.sample.messageID,
    at: input.sample.at,
    kind: input.kind,
    ...(model === undefined ? {} : { model }),
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
    ...(diff.appended === undefined ? {} : { appended: diff.appended }),
    ...(diff.outline.length === 0 ? {} : { outline: diff.outline }),
    ...(diff.tree.length === 0 ? {} : { tree: diff.tree }),
    ...(diff.request === undefined ? {} : { request: diff.request }),
  }
}

/**
 * 输入：报文对。
 * 输出：与上一份抓到的报文的差异；没有上一份报文时记 unknown。
 * 预期：两份报文总是强制对比（不检查 messageID / 请求类型）；
 *       只要当前报文存在，就一定带上原始请求原文，面板不会有「没有可展示的请求」。
 */
function comparePair(pair: RequestPair): RequestDiff {
  const current = pair.current
  if (current === undefined) return { cause: "unknown", outline: [], tree: [] }
  const outline = outlineFromBody(current.body)
  const previous = pair.previous
  if (previous === undefined) {
    return { cause: "unknown", outline, tree: treeFromBody(current.body), request: requestPreview(current.body) }
  }
  const diff = diffRequests(previous.body, current.body)
  return {
    cause: diff.cause,
    ...(diff.breakPoint === undefined ? {} : { breakPoint: diff.breakPoint }),
    ...(diff.appended === undefined ? {} : { appended: diff.appended }),
    outline: diff.outline.length === 0 ? outline : diff.outline,
    tree: diff.tree.length === 0 ? treeFromBody(current.body) : diff.tree,
    request: diff.request ?? requestPreview(current.body),
  }
}
