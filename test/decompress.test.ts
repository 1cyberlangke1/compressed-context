import { describe, expect, it } from "vitest"

import { collectBlockContent, type CollectInput } from "../src/compression/decompress.ts"
import type { Block } from "../src/compression/state.ts"

const summary = {
  title: "t",
  goal: "g",
  constraints: [],
  decisions: [],
  progress: { completed: [], active: [], blocked: [] },
  open_items: [],
  files: [],
  facts: [],
}

/** 输入：id/tier/order/范围/sourceBlockIds；输出：测试用块。 */
const block = (id: string, tier: 1 | 2 | 3, order: number, sourceIds?: string[]): Block => ({
  id,
  tier,
  summary: { ...summary, title: `title ${id}` },
  fromId: `${id}-from`,
  toId: `${id}-to`,
  tokensBefore: 100,
  tokensAfter: 10,
  at: order,
  order,
  ...(sourceIds === undefined ? {} : { sourceBlockIds: sourceIds }),
})

const input = (overrides?: Partial<CollectInput>): CollectInput => ({
  blocks: [
    block("b3", 3, 3, ["b5", "b6"]),
    block("b5", 2, 1, ["b1", "b2"]),
    block("b6", 2, 2, ["b7"]),
    block("b1", 1, 1),
    block("b2", 1, 2),
    block("b7", 1, 4),
  ],
  transcripts: new Map([
    ["b1", "t1 body"],
    ["b2", "t2 body"],
    ["b7", "t7 body"],
  ]),
  ...overrides,
})

describe("collectBlockContent", () => {
  it("T1 块返回自身原文", () => {
    const result = collectBlockContent(input(), "b1", false)
    expect(result.text).toBe("t1 body")
    expect(result.found).toBe(true)
  })

  it("T2 块 full:false 返回直接子块摘要（不递归原文）", () => {
    const result = collectBlockContent(input(), "b5", false)
    expect(result.text).toContain("title b1")
    expect(result.text).toContain("title b2")
    expect(result.text).not.toContain("t1 body")
    expect(result.found).toBe(true)
  })

  it("T3 块 full:false 返回直接子块（T2）摘要", () => {
    const result = collectBlockContent(input(), "b3", false)
    expect(result.text).toContain("title b5")
    expect(result.text).toContain("title b6")
    expect(result.text).not.toContain("t1 body")
  })

  it("T3 块 full:true 递归到 T1 原文", () => {
    const result = collectBlockContent(input(), "b3", true)
    expect(result.text).toContain("t1 body")
    expect(result.text).toContain("t2 body")
    expect(result.text).toContain("t7 body")
  })

  it("T1 块 full:true 与 false 相同（已是原文层）", () => {
    expect(collectBlockContent(input(), "b1", true).text).toBe("t1 body")
  })

  it("未知块返回 found:false", () => {
    expect(collectBlockContent(input(), "b999", false)).toEqual({ text: "", found: false })
  })

  it("T1 块缺 transcript 时返回空文本但 found:true", () => {
    const result = collectBlockContent(input({ transcripts: new Map() }), "b1", false)
    expect(result.found).toBe(true)
    expect(result.text).toBe("")
  })

  it("循环引用不挂死（防御）", () => {
    const cyclic: Block[] = [block("b1", 2, 1, ["b1"])]
    const result = collectBlockContent({ blocks: cyclic, transcripts: new Map([["b1", "x"]]) }, "b1", true)
    expect(result.found).toBe(true)
  })
})
