import { describe, expect, it } from "vitest"

import type { SummaryFields } from "../src/compression/schema.ts"
import {
  PENDING_TIMEOUT_MS,
  commitPending,
  dropPending,
  expireStalePending,
  parseState,
  retryPending,
  withPending,
  type Block,
  type State,
} from "../src/compression/state.ts"

/** 输入：标题；输出：最小合法摘要。 */
function summary(title: string): SummaryFields {
  return {
    title,
    goal: title,
    constraints: [],
    decisions: [],
    open_items: [],
    files: [],
    facts: [],
    progress: { completed: [], active: [], blocked: [] },
  }
}

/** 输入：id + order；输出：T1 块。 */
function block(id: string, order: number): Block {
  return {
    id,
    tier: 1,
    depth: 1,
    summary: summary(id),
    fromId: `m-${id}`,
    toId: `m-${id}`,
    sourceTokens: 100,
    summaryTokens: 10,
    at: order,
    order,
  }
}

/** 输入：id + tier + order + 旧字段；输出：旧版存储形状的块。 */
function legacyBlock(
  id: string,
  tier: number,
  order: number,
  tokensBefore: number,
  tokensAfter: number,
  sourceBlockIds?: readonly string[],
): Record<string, unknown> {
  return {
    id,
    tier,
    summary: summary(id),
    fromId: `m-${id}`,
    toId: `m-${id}`,
    tokensBefore,
    tokensAfter,
    at: order,
    order,
    ...(sourceBlockIds === undefined ? {} : { sourceBlockIds }),
  }
}

describe("state transitions", () => {
  it("commitPending 转正 pending，清 lastError，保留 phase", () => {
    const pending = block("b2", 2)
    const next = commitPending({
      blocks: [block("b1", 1)],
      pending,
      phase: 2,
      attempts: 2,
      lastError: "old error",
    })
    expect(next.blocks.map((item) => item.id)).toEqual(["b1", "b2"])
    expect(next.pending).toBeUndefined()
    expect(next.attempts).toBe(0)
    expect(next.phase).toBe(2)
    expect(next.lastError).toBeUndefined()
  })

  it("commitPending 保留提醒基线与计数", () => {
    const next = commitPending({
      blocks: [block("b1", 1)],
      pending: block("b2", 2),
      attempts: 0,
      nudgeBaselineTokens: 90_000,
      nudgeCount: 2,
    })
    expect(next.nudgeBaselineTokens).toBe(90_000)
    expect(next.nudgeCount).toBe(2)
  })

  it("commitPending 没有 pending 时原样返回", () => {
    const state = { blocks: [block("b1", 1)], attempts: 2, lastError: "x" }
    expect(commitPending(state)).toBe(state)
  })

  it("dropPending 清 pending/phase，attempts+1", () => {
    const next = dropPending(
      {
        blocks: [block("b1", 1)],
        pending: block("b2", 2),
        phase: 3,
        attempts: 1,
      },
      "failed",
    )
    expect(next.blocks.map((item) => item.id)).toEqual(["b1"])
    expect(next.pending).toBeUndefined()
    expect(next.phase).toBeUndefined()
    expect(next.attempts).toBe(2)
    expect(next.lastError).toBe("failed")
  })

  it("retryPending 保留 phase 到上限，第 3 次失败后清掉", () => {
    const first = retryPending({ blocks: [block("b1", 1)], phase: 2, attempts: 0 }, "bad")
    expect(first.pending).toBeUndefined()
    expect(first.phase).toBe(2)
    expect(first.attempts).toBe(1)
    const second = retryPending({ ...first, phase: 2 }, "bad")
    expect(second.phase).toBe(2)
    expect(second.attempts).toBe(2)
    const third = retryPending({ ...second, phase: 2 }, "bad")
    expect(third.phase).toBeUndefined()
    expect(third.attempts).toBe(3)
  })

  it("withPending 保留其他字段", () => {
    const next = withPending(
      { blocks: [block("b1", 1)], attempts: 2, phase: 2, lastError: "x" },
      block("b2", 2),
    )
    expect(next.blocks.map((item) => item.id)).toEqual(["b1"])
    expect(next.pending?.id).toBe("b2")
    expect(next.attempts).toBe(2)
    expect(next.phase).toBe(2)
    expect(next.lastError).toBe("x")
  })

  it("parseState 忽略旧 autoInFlight 字段", () => {
    expect(parseState({ blocks: [], attempts: 0, autoInFlight: true })).toEqual({
      blocks: [],
      attempts: 0,
    })
  })

  it("旧版 tokensBefore/tokensAfter 迁移为 sourceTokens/summaryTokens", () => {
    const parsed = parseState({ blocks: [legacyBlock("b1", 1, 1, 100, 10)], attempts: 0 })
    expect(parsed.blocks[0]).toMatchObject({ sourceTokens: 100, summaryTokens: 10 })
  })

  it("旧版合并块按 sourceBlockIds 递归求原始 token 总量", () => {
    const parsed = parseState({
      blocks: [
        legacyBlock("b1", 1, 1, 100, 10),
        legacyBlock("b2", 1, 2, 300, 20),
        legacyBlock("b3", 2, 1, 30, 5, ["b1", "b2"]),
      ],
      attempts: 0,
    })
    expect(parsed.blocks.find((item) => item.id === "b3")?.sourceTokens).toBe(400)
    expect(parsed.blocks.find((item) => item.id === "b3")?.summaryTokens).toBe(5)
  })

  it("旧版合并块缺子块时保留原值，不丢状态", () => {
    const parsed = parseState({
      blocks: [legacyBlock("b3", 2, 1, 30, 5, ["missing"])],
      attempts: 0,
    })
    expect(parsed.blocks[0]).toMatchObject({ sourceTokens: 30, summaryTokens: 5 })
  })

  it("新字段优先于旧字段", () => {
    const parsed = parseState({
      blocks: [{ ...legacyBlock("b1", 1, 1, 100, 10), sourceTokens: 777, summaryTokens: 77 }],
      attempts: 0,
    })
    expect(parsed.blocks[0]).toMatchObject({ sourceTokens: 777, summaryTokens: 77 })
  })

  it("封顶前的 T4/T5 读入后夹到 3，depth 退回 tier", () => {
    const parsed = parseState({
      blocks: [legacyBlock("b1", 4, 1, 100, 10), legacyBlock("b2", 5, 2, 100, 10)],
      attempts: 0,
    })
    expect(parsed.blocks.map((item) => item.tier)).toEqual([3, 3])
    expect(parsed.blocks.map((item) => item.depth)).toEqual([3, 3])
  })

  it("depth 原样读回；缺字段时退回 tier", () => {
    const withDepth = { ...block("b1", 1), depth: 7 }
    expect(parseState({ blocks: [withDepth], attempts: 0 }).blocks[0]?.depth).toBe(7)
    // legacyBlock 不带 depth：回退到它自己的层。
    expect(parseState({ blocks: [legacyBlock("b2", 2, 2, 10, 1)], attempts: 0 }).blocks[0]?.depth).toBe(2)
  })
})

describe("expireStalePending", () => {
  it("首次看到无标记的 pending 时打上 pendingAt，不转正", () => {
    const state: State = { blocks: [], attempts: 0, pending: block("b1", 1) }
    const next = expireStalePending(state, 1_000)
    expect(next.pendingAt).toBe(1_000)
    expect(next.pending?.id).toBe("b1")
  })

  it("超时后强制转正并清掉 pendingAt", () => {
    const state: State = {
      blocks: [],
      attempts: 0,
      pending: block("b1", 1),
      pendingAt: 1_000,
      phase: 2,
    }
    const next = expireStalePending(state, 1_000 + PENDING_TIMEOUT_MS + 1)
    expect(next.pending).toBeUndefined()
    expect(next.pendingAt).toBeUndefined()
    expect(next.blocks.map((item) => item.id)).toEqual(["b1"])
    // 事件对账有它自己的语义：转正保留 phase，这里也一致。
    expect(next.phase).toBe(2)
  })

  it("未超时的 pending 原样保留", () => {
    const state: State = { blocks: [], attempts: 0, pending: block("b1", 1), pendingAt: 1_000 }
    expect(expireStalePending(state, 1_000 + PENDING_TIMEOUT_MS - 1)).toBe(state)
  })

  it("没有 pending 时原样返回", () => {
    const state: State = { blocks: [block("b1", 1)], attempts: 0 }
    expect(expireStalePending(state, 999_999)).toBe(state)
  })
})
