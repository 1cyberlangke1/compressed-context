import type { Schema } from "effect"

import type { SummaryFields } from "./schema.ts"

/** 压缩层级：1 = 原文摘要，2/3 = 摘要再蒸馏。 */
export type Tier = 1 | 2 | 3

/** 下一次 compaction 的目的；缺省表示 T1。 */
export type CompactionPhase = "t2" | "t3"

/** 一个已落盘或待落盘的压缩块。 */
export interface Block {
  readonly id: string
  readonly tier: Tier
  readonly summary: SummaryFields
  readonly fromId: string
  readonly toId: string
  readonly tokensBefore: number
  readonly tokensAfter: number
  readonly at: number
  /** active 链中的顺序；合并块占第一个源块的位置。 */
  readonly order: number
  /** 被本块合并的源块；空表示原始 T1 块。 */
  readonly sourceBlockIds?: readonly string[]
}

/** 旧版本没有 order；读取时按下标补齐。 */
type StoredBlock = Omit<Block, "order"> & { readonly order?: number }

/** 旧版本把 title 存成可选；读取时补上，避免丢块。 */
type LegacyBlock = Omit<StoredBlock, "summary"> & {
  readonly summary: Omit<SummaryFields, "title"> & { readonly title?: string }
}

/** 每个会话一份的压缩状态。 */
export interface State {
  readonly v: 1
  readonly blocks: readonly Block[]
  readonly pending?: Block
  readonly autoInFlight?: boolean
  /** 下一次 compaction 是二级压缩；T1 时缺省。 */
  readonly phase?: CompactionPhase
  readonly attempts: number
  readonly lastError?: string
}

/** 服务端 storage 的最小接口，便于测试替身。 */
export interface StorageLike {
  get(key: string): Promise<Schema.Json | undefined>
  set(key: string, value: Schema.Json): Promise<void>
  remove(key: string): Promise<void>
}

export const STATE_PREFIX = "compression:state:"

export const EMPTY_STATE: State = { v: 1, blocks: [], attempts: 0 }

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

/** 输入：旧块；输出：标题非空的块；预期：缺标题时用 goal 的前 80 个字符补。 */
function withTitle(block: LegacyBlock): StoredBlock {
  const title = block.summary.title?.trim()
  const goal = block.summary.goal.trim().replace(/\s+/g, " ")
  const fallback = goal.length === 0 ? "untitled" : goal.length <= 80 ? goal : `${goal.slice(0, 77)}...`
  return {
    ...block,
    summary: {
      ...block.summary,
      title: title !== undefined && title.length > 0 ? title : fallback,
    },
  }
}

function isBlock(value: unknown): value is LegacyBlock {
  if (typeof value !== "object" || value === null) return false
  const block = value as Record<string, unknown>
  if (typeof block["id"] !== "string") return false
  const tier = block["tier"]
  if (tier !== 1 && tier !== 2 && tier !== 3) return false
  if (typeof block["fromId"] !== "string" || typeof block["toId"] !== "string") return false
  if (typeof block["tokensBefore"] !== "number" || typeof block["tokensAfter"] !== "number") return false
  if (typeof block["at"] !== "number") return false
  const order = block["order"]
  if (order !== undefined && typeof order !== "number") return false
  const sourceBlockIds = block["sourceBlockIds"]
  if (sourceBlockIds !== undefined && !isStringArray(sourceBlockIds)) return false
  const summary = block["summary"]
  if (typeof summary !== "object" || summary === null) return false
  const fields = summary as Record<string, unknown>
  if (typeof fields["goal"] !== "string") return false
  if (fields["title"] !== undefined && typeof fields["title"] !== "string") return false
  if (!isStringArray(fields["constraints"])) return false
  if (!isStringArray(fields["decisions"])) return false
  if (!isStringArray(fields["open_items"])) return false
  if (!isStringArray(fields["files"])) return false
  if (!isStringArray(fields["facts"])) return false
  const progress = fields["progress"]
  if (typeof progress !== "object" || progress === null) return false
  const p = progress as Record<string, unknown>
  return isStringArray(p["completed"]) && isStringArray(p["active"]) && isStringArray(p["blocked"])
}

/** 输入：旧块 + 缺省 order；输出：补齐后的块。 */
function normalizeBlock(block: LegacyBlock, fallbackOrder: number): Block {
  const titled = withTitle(block)
  return { ...titled, order: titled.order ?? fallbackOrder }
}

/**
 * 输入：storage 里的原始值。
 * 输出：合法状态；损坏或版本不符时返回空状态。
 * 预期：绝不抛错，坏数据只会丢历史块。
 */
export function parseState(value: unknown): State {
  if (typeof value !== "object" || value === null) return EMPTY_STATE
  const record = value as Record<string, unknown>
  if (record["v"] !== 1) return EMPTY_STATE
  const blocks = Array.isArray(record["blocks"])
    ? record["blocks"].filter(isBlock).map((block, index) => normalizeBlock(block, index))
    : []
  const pending = isBlock(record["pending"]) ? normalizeBlock(record["pending"], blocks.length) : undefined
  const attempts = typeof record["attempts"] === "number" ? record["attempts"] : 0
  const lastError = typeof record["lastError"] === "string" ? record["lastError"] : undefined
  const rawPhase = record["phase"]
  const phase: CompactionPhase | undefined = rawPhase === "t2" || rawPhase === "t3" ? rawPhase : undefined
  return {
    v: 1,
    blocks,
    attempts,
    ...(pending === undefined ? {} : { pending }),
    ...(lastError === undefined ? {} : { lastError }),
    ...(phase === undefined ? {} : { phase }),
  }
}

/** 输入：storage + sessionID；输出：状态。 */
export async function loadState(storage: StorageLike, sessionID: string): Promise<State> {
  return parseState(await storage.get(stateKey(sessionID)))
}

/** 输入：storage + sessionID + 状态；输出：无；预期：写入 JSON。 */
export async function saveState(storage: StorageLike, sessionID: string, state: State): Promise<void> {
  await storage.set(stateKey(sessionID), state as unknown as Schema.Json)
}

/** 输入：状态；输出：pending 转正后的新状态；预期：保留下一层 phase。 */
export function commitPending(state: State): State {
  if (!state.pending) return state
  return {
    v: 1,
    blocks: [...state.blocks, state.pending],
    attempts: 0,
    ...(state.phase === undefined ? {} : { phase: state.phase }),
  }
}

/** 输入：状态 + 错误；输出：丢弃 pending 后的新状态；预期：失败时清掉 phase。 */
export function dropPending(state: State, error: string): State {
  return {
    v: 1,
    blocks: state.blocks,
    attempts: state.attempts + 1,
    lastError: error,
  }
}

/** 输入：状态 + 下一层 phase；输出：替换 phase 后的状态。 */
export function withPhase(state: State, phase: CompactionPhase | undefined): State {
  return {
    v: state.v,
    blocks: state.blocks,
    attempts: state.attempts,
    ...(state.pending === undefined ? {} : { pending: state.pending }),
    ...(state.autoInFlight === undefined ? {} : { autoInFlight: state.autoInFlight }),
    ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
    ...(phase === undefined ? {} : { phase }),
  }
}

/** 输入：状态 + 新块；输出：挂上 pending 的新状态。 */
export function withPending(state: State, block: Block): State {
  return { ...state, pending: block }
}
