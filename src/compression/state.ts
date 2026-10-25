import type { Schema } from "effect"

import { toBabelSummary } from "./babel.ts"
import { isSessionDeleted } from "./deleted-sessions.ts"
import { type Summary, type SummaryFields } from "./schema.ts"

/** 压缩层级：1 = 原文摘要，2+ = 摘要再蒸馏；同层合并产出层+1，最高 MAX_TIER。 */
export type Tier = number

/** 层级上限：顶层再做合并时仍是这个层，形成「滚动累积块」。 */
export const MAX_TIER = 3

/** 下一次 compaction 的目标层级；旧数据 "t2"/"t3" 读取时映射成 2/3。 */
export type CompactionPhase = number

/** 一个已落盘或待落盘的压缩块。 */
export interface Block {
  readonly id: string
  readonly tier: Tier
  /**
   * 树高：T1 块 = 1；合并块 = 1 + 子块最大高度。
   * 与 tier 解耦（tier 封顶 3 后仍会继续增长），供 UI 渐变与统计使用；读取是字段访问，O(1)。
   */
  readonly height: number
  readonly summary: Summary
  readonly fromId: string
  readonly toId: string
  /** 这个块代表的原始 token 总量；合并块等于所有子块之和。 */
  readonly sourceTokens: number
  /** 这个块摘要的估算 token 量。 */
  readonly summaryTokens: number
  readonly at: number
  /** active 链中的顺序；合并块占第一个源块的位置。 */
  readonly order: number
  /** 被本块合并的源块；空表示原始 T1 块。 */
  readonly sourceBlockIds?: readonly string[]
}

/** 每个会话一份的压缩状态。 */
export interface State {
  readonly blocks: readonly Block[]
  readonly pending?: Block
  /** pending 挂起的时间戳（毫秒）；转正/丢弃后清除。事件丢失时按它兜底过期。 */
  readonly pendingAt?: number
  /** 下一次 compaction 是二级压缩；T1 时缺省。 */
  readonly phase?: CompactionPhase
  readonly attempts: number
  readonly lastError?: string
  /** 上一次主动压缩提醒时的上下文 token 数；缺省表示还没建立基线。 */
  readonly nudgeBaselineTokens?: number
  /** 已发出的主动压缩提醒次数。 */
  readonly nudgeCount?: number
  /**
   * 自上次 T1 以来连续合并了几刀。
   * 预期：摘要怎么合都压不进预算时用它刹住连环压缩；新 T1 落盘时归零。
   */
  readonly distillRounds?: number
}

/** pending 超过这个时长还没被事件转正就视为丢失，强制转正（宁可重复展示摘要，不可卡死会话）。 */
export const PENDING_TIMEOUT_MS = 10 * 60_000

/** 服务端 storage 的最小接口，便于测试替身。 */
export interface StorageLike {
  get(key: string): Promise<Schema.Json | undefined>
  set(key: string, value: Schema.Json): Promise<void>
  remove(key: string): Promise<void>
}

export const STATE_PREFIX = "compression:state:"

/** 同一次 T1 之后最多连合几刀：防止「怎么合都压不进预算」时无限连环压缩。 */
export const MAX_DISTILL_ROUNDS = 8

export const EMPTY_STATE: State = { blocks: [], attempts: 0 }

/** 输入：sessionID；输出：storage key。 */
export function stateKey(sessionID: string): string {
  return STATE_PREFIX + sessionID
}

/** 输入：块列表；输出：下一个可用的 order。 */
export function nextOrder(blocks: readonly Block[]): number {
  return blocks.reduce((max, block) => Math.max(max, block.order), 0) + 1
}

/** 输入：已落盘块 + 可选 pending；输出：下一个可用的 bN id。 */
export function nextBlockId(blocks: readonly Block[], pending?: Block): string {
  let max = 0
  const all = pending === undefined ? blocks : [...blocks, pending]
  for (const block of all) {
    const numeric = Number(block.id.startsWith("b") ? block.id.slice(1) : "")
    if (Number.isInteger(numeric) && numeric > max) max = numeric
  }
  return `b${(max + 1).toString()}`
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

/** 输入：存储里的摘要；输出：JSON 摘要字段；形状不合法时 undefined。 */
function parseFields(value: unknown): SummaryFields | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const fields = value as Record<string, unknown>
  if (typeof fields["title"] !== "string" || typeof fields["goal"] !== "string") return undefined
  if (!isStringArray(fields["constraints"])) return undefined
  if (!isStringArray(fields["decisions"])) return undefined
  if (!isStringArray(fields["open_items"])) return undefined
  if (!isStringArray(fields["files"])) return undefined
  if (!isStringArray(fields["facts"])) return undefined
  const progress = fields["progress"]
  if (typeof progress !== "object" || progress === null) return undefined
  const p = progress as Record<string, unknown>
  if (!isStringArray(p["completed"]) || !isStringArray(p["active"]) || !isStringArray(p["blocked"])) {
    return undefined
  }
  return {
    title: fields["title"],
    goal: fields["goal"],
    constraints: fields["constraints"],
    decisions: fields["decisions"],
    progress: { completed: p["completed"], active: p["active"], blocked: p["blocked"] },
    open_items: fields["open_items"],
    files: fields["files"],
    facts: fields["facts"],
  }
}

/** 输入：存储里的摘要；输出：规范摘要；形状不合法时 undefined。 */
function parseSummary(value: unknown): Summary | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record["format"] === "markdown") {
    if (typeof record["title"] !== "string" || typeof record["text"] !== "string") return undefined
    return { format: "markdown", title: record["title"], text: record["text"] }
  }
  if (record["format"] === "babel") {
    if (typeof record["text"] !== "string") return undefined
    return toBabelSummary(
      record["text"],
      typeof record["title"] === "string" ? record["title"] : undefined,
      typeof record["goal"] === "string" ? record["goal"] : undefined,
    )
  }
  if ("format" in record) return undefined
  return parseFields(value)
}

/** 输入：存储里的块；输出：规范块；形状不合法时 undefined。 */
function parseBlock(value: unknown): Block | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const block = value as Record<string, unknown>
  if (typeof block["id"] !== "string") return undefined
  const rawTier = block["tier"]
  // 旧数据可能存着封顶前的 T4/T5：读得进来，统一夹到当前上限。
  if (typeof rawTier !== "number" || !Number.isInteger(rawTier) || rawTier < 1) return undefined
  const tier = Math.min(MAX_TIER, rawTier)
  // 高度字段：新数据叫 height；旧数据叫 depth，读的时候一次性转换。
  const rawHeight = block["height"] ?? block["depth"]
  const height =
    typeof rawHeight === "number" && Number.isInteger(rawHeight) && rawHeight >= 1 ? rawHeight : tier
  if (typeof block["fromId"] !== "string" || typeof block["toId"] !== "string") return undefined
  // 旧版字段 tokensBefore/tokensAfter 继续可读；新字段优先。
  const sourceTokens =
    typeof block["sourceTokens"] === "number"
      ? block["sourceTokens"]
      : typeof block["tokensBefore"] === "number"
        ? block["tokensBefore"]
        : undefined
  const summaryTokens =
    typeof block["summaryTokens"] === "number"
      ? block["summaryTokens"]
      : typeof block["tokensAfter"] === "number"
        ? block["tokensAfter"]
        : undefined
  if (sourceTokens === undefined || summaryTokens === undefined) return undefined
  if (typeof block["at"] !== "number" || typeof block["order"] !== "number") return undefined
  const sourceBlockIds = block["sourceBlockIds"]
  if (sourceBlockIds !== undefined && !isStringArray(sourceBlockIds)) return undefined
  const summary = parseSummary(block["summary"])
  if (summary === undefined) return undefined
  return {
    id: block["id"],
    tier,
    height,
    summary,
    fromId: block["fromId"],
    toId: block["toId"],
    sourceTokens,
    summaryTokens,
    at: block["at"],
    order: block["order"],
    ...(sourceBlockIds === undefined ? {} : { sourceBlockIds }),
  }
}

/**
 * 输入：解析后的块 + pending。
 * 输出：sourceTokens 统一为「代表的原始 token 总量」的块。
 * 预期：旧版合并块把子摘要量存进 tokensBefore；这里按 sourceBlockIds 递归求和覆盖。
 *       子块缺失或成环时保留原值，不阻断状态读取。
 */
function normalizeSourceTokens(
  blocks: readonly Block[],
  pending: Block | undefined,
): { blocks: Block[]; pending: Block | undefined } {
  const byId = new Map<string, Block>()
  for (const block of blocks) byId.set(block.id, block)
  if (pending !== undefined) byId.set(pending.id, pending)
  const memo = new Map<string, number>()

  const compute = (block: Block, visiting: Set<string>): number => {
    const cached = memo.get(block.id)
    if (cached !== undefined) return cached
    const sources = block.sourceBlockIds ?? []
    if (block.tier === 1 || sources.length === 0) {
      memo.set(block.id, block.sourceTokens)
      return block.sourceTokens
    }
    if (visiting.has(block.id)) return block.sourceTokens
    visiting.add(block.id)
    let total = 0
    let complete = true
    for (const id of sources) {
      const child = byId.get(id)
      if (child === undefined) {
        complete = false
        break
      }
      total += compute(child, visiting)
    }
    visiting.delete(block.id)
    const value = complete ? total : block.sourceTokens
    memo.set(block.id, value)
    return value
  }

  const normalize = (block: Block): Block => {
    const value = compute(block, new Set())
    return value === block.sourceTokens ? block : { ...block, sourceTokens: value }
  }

  return {
    blocks: blocks.map(normalize),
    pending: pending === undefined ? undefined : normalize(pending),
  }
}

/**
 * 输入：storage 里的原始值。
 * 输出：合法状态；损坏时返回空状态。
 * 预期：不读版本号、不做迁移；坏块直接丢弃。
 */
export function parseState(value: unknown): State {
  if (typeof value !== "object" || value === null) return EMPTY_STATE
  const record = value as Record<string, unknown>
  const parsedBlocks = Array.isArray(record["blocks"])
    ? record["blocks"].map(parseBlock).filter((block): block is Block => block !== undefined)
    : []
  const parsedPending = parseBlock(record["pending"])
  const normalized = normalizeSourceTokens(parsedBlocks, parsedPending)
  const blocks = normalized.blocks
  const pending = normalized.pending
  const attempts = typeof record["attempts"] === "number" ? record["attempts"] : 0
  const lastError = typeof record["lastError"] === "string" ? record["lastError"] : undefined
  const nudgeBaselineTokens =
    typeof record["nudgeBaselineTokens"] === "number" ? record["nudgeBaselineTokens"] : undefined
  const nudgeCount = typeof record["nudgeCount"] === "number" ? record["nudgeCount"] : undefined
  const distillRounds =
    typeof record["distillRounds"] === "number" && Number.isInteger(record["distillRounds"])
      ? record["distillRounds"]
      : undefined
  const rawPhase = record["phase"]
  // 旧数据 phase 是 "t2"/"t3" 字符串；新数据是数字目标层级。两者都接受，其余丢弃。
  const phase: CompactionPhase | undefined =
    rawPhase === "t2"
      ? 2
      : rawPhase === "t3"
        ? 3
        : typeof rawPhase === "number" && rawPhase >= 2
          ? rawPhase
          : undefined
  return {
    blocks,
    attempts,
    ...(pending === undefined ? {} : { pending }),
    ...(lastError === undefined ? {} : { lastError }),
    ...(nudgeBaselineTokens === undefined ? {} : { nudgeBaselineTokens }),
    ...(nudgeCount === undefined ? {} : { nudgeCount }),
    ...(distillRounds === undefined ? {} : { distillRounds }),
    ...(phase === undefined ? {} : { phase }),
  }
}

/** 输入：storage + sessionID；输出：状态。 */
export async function loadState(storage: StorageLike, sessionID: string): Promise<State> {
  return parseState(await storage.get(stateKey(sessionID)))
}

/**
 * 输入：storage + sessionID + 状态；输出：无；预期：写入 JSON；已删会话直接跳过。
 * 仅用于测试/初始化。生产代码必须走 StateStore.transact，否则会和并发事务互相覆盖。
 */
export async function saveState(storage: StorageLike, sessionID: string, state: State): Promise<void> {
  if (isSessionDeleted(sessionID)) return
  await storage.set(stateKey(sessionID), state as unknown as Schema.Json)
}

/** 输入：状态；输出：pending 转正后的新状态；预期：成功时清 lastError，保留下一层 phase。 */
export function commitPending(state: State): State {
  if (!state.pending) return state
  return {
    blocks: [...state.blocks, state.pending],
    attempts: 0,
    ...(state.nudgeBaselineTokens === undefined ? {} : { nudgeBaselineTokens: state.nudgeBaselineTokens }),
    ...(state.nudgeCount === undefined ? {} : { nudgeCount: state.nudgeCount }),
    ...(state.distillRounds === undefined ? {} : { distillRounds: state.distillRounds }),
    ...(state.phase === undefined ? {} : { phase: state.phase }),
  }
}
/** 输入：状态 + 错误；输出：丢弃 pending 后的新状态；预期：失败时清 pending/phase。 */
export function dropPending(state: State, error: string): State {
  return {
    blocks: state.blocks,
    attempts: state.attempts + 1,
    lastError: error,
    ...(state.nudgeBaselineTokens === undefined ? {} : { nudgeBaselineTokens: state.nudgeBaselineTokens }),
    ...(state.nudgeCount === undefined ? {} : { nudgeCount: state.nudgeCount }),
    ...(state.distillRounds === undefined ? {} : { distillRounds: state.distillRounds }),
  }
}

/**
 * 输入：状态 + 当前时间。
 * 输出：pending 超过 PENDING_TIMEOUT_MS 时强制转正；否则原样返回（含 pendingAt 首次标记）。
 * 预期：事件丢失时 pending 会永久卡住自动压缩（blockedByState 挡住一切），
 *       这里按时间兜底：宁可摘要重复展示一次，也不让会话卡死。
 */
export function expireStalePending(state: State, now: number): State {
  if (state.pending === undefined) return state
  const marked = state.pendingAt ?? now
  if (now - marked < PENDING_TIMEOUT_MS) {
    return state.pendingAt === undefined ? { ...state, pendingAt: marked } : state
  }
  const committed = commitPending(state)
  const next = {
    blocks: committed.blocks,
    attempts: committed.attempts,
    ...(committed.phase === undefined ? {} : { phase: committed.phase }),
    ...(committed.nudgeBaselineTokens === undefined
      ? {}
      : { nudgeBaselineTokens: committed.nudgeBaselineTokens }),
    ...(committed.nudgeCount === undefined ? {} : { nudgeCount: committed.nudgeCount }),
    ...(committed.distillRounds === undefined ? {} : { distillRounds: committed.distillRounds }),
  }
  return next
}

/**
 * 输入：失败后的状态 + 错误。
 * 输出：清 pending，保留 phase 让下一次请求重试。
 * 预期：失败只记 lastError，不计数、不关闭自动压缩。
 */
export function retryPending(state: State, error: string): State {
  return {
    blocks: state.blocks,
    attempts: state.attempts + 1,
    lastError: error,
    ...(state.nudgeBaselineTokens === undefined ? {} : { nudgeBaselineTokens: state.nudgeBaselineTokens }),
    ...(state.nudgeCount === undefined ? {} : { nudgeCount: state.nudgeCount }),
    ...(state.distillRounds === undefined ? {} : { distillRounds: state.distillRounds }),
    ...(state.phase === undefined ? {} : { phase: state.phase }),
  }
}

/**
 * 输入：状态；输出：清掉已排层级后的新状态。
 * 预期：摘要回到预算内时用——否则 phase 会每个 step 都触发一次压缩。
 */
export function clearPhase(state: State): State {
  return {
    blocks: state.blocks,
    attempts: state.attempts,
    ...(state.pending === undefined ? {} : { pending: state.pending }),
    ...(state.pendingAt === undefined ? {} : { pendingAt: state.pendingAt }),
    ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
    ...(state.nudgeBaselineTokens === undefined ? {} : { nudgeBaselineTokens: state.nudgeBaselineTokens }),
    ...(state.nudgeCount === undefined ? {} : { nudgeCount: state.nudgeCount }),
    ...(state.distillRounds === undefined ? {} : { distillRounds: state.distillRounds }),
  }
}

/** 输入：状态 + 新块；输出：挂上 pending 的新状态。 */
export function withPending(state: State, block: Block): State {
  return { ...state, pending: block }
}
