import { describe, expect, it } from "vitest"

import type { SummaryFields } from "../src/compression/schema.ts"
import {
  commitPending,
  dropPending,
  parseState,
  withPending,
  type Block,
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
    summary: summary(id),
    fromId: `m-${id}`,
    toId: `m-${id}`,
    tokensBefore: 100,
    tokensAfter: 10,
    at: order,
    order,
  }
}

describe("state transitions", () => {
  it("commitPending 转正 pending，清 lastError/terminal，保留 phase", () => {
    const pending = block("b2", 2)
    const next = commitPending({
      v: 1,
      blocks: [block("b1", 1)],
      pending,
      phase: "t2",
      attempts: 2,
      lastError: "old error",
      terminal: "old terminal",
    })
    expect(next.blocks.map((item) => item.id)).toEqual(["b1", "b2"])
    expect(next.pending).toBeUndefined()
    expect(next.attempts).toBe(0)
    expect(next.phase).toBe("t2")
    expect(next.lastError).toBeUndefined()
    expect(next.terminal).toBeUndefined()
  })

  it("commitPending 没有 pending 时原样返回", () => {
    const state = { v: 1 as const, blocks: [block("b1", 1)], attempts: 2, lastError: "x" }
    expect(commitPending(state)).toBe(state)
  })

  it("dropPending 清 pending/phase，保留 terminal，attempts+1", () => {
    const next = dropPending(
      {
        v: 1,
        blocks: [block("b1", 1)],
        pending: block("b2", 2),
        phase: "t3",
        attempts: 1,
        terminal: "stop",
      },
      "failed",
    )
    expect(next.blocks.map((item) => item.id)).toEqual(["b1"])
    expect(next.pending).toBeUndefined()
    expect(next.phase).toBeUndefined()
    expect(next.attempts).toBe(2)
    expect(next.lastError).toBe("failed")
    expect(next.terminal).toBe("stop")
  })

  it("withPending 保留其他字段", () => {
    const next = withPending(
      { v: 1, blocks: [block("b1", 1)], attempts: 2, phase: "t2", lastError: "x", terminal: "stop" },
      block("b2", 2),
    )
    expect(next.blocks.map((item) => item.id)).toEqual(["b1"])
    expect(next.pending?.id).toBe("b2")
    expect(next.attempts).toBe(2)
    expect(next.phase).toBe("t2")
    expect(next.lastError).toBe("x")
    expect(next.terminal).toBe("stop")
  })

  it("parseState 忽略旧 autoInFlight 字段", () => {
    expect(parseState({ v: 1, blocks: [], attempts: 0, autoInFlight: true })).toEqual({
      v: 1,
      blocks: [],
      attempts: 0,
    })
  })
})
