import { describe, expect, it } from "vitest"
import type { Schema } from "effect"

import { resolveDecompress } from "../src/compression/decompress.ts"
import type { Block, StorageLike } from "../src/compression/state.ts"

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

const storage = {
  get: (key: string) => {
    if (key.endsWith("ses_x")) {
      return Promise.resolve({
        v: 1,
        blocks: [
          block("b3", 3, 3, ["b5", "b6"]),
          block("b5", 2, 1, ["b1", "b2"]),
          block("b6", 2, 2, ["b7"]),
          block("b1", 1, 1),
          block("b2", 1, 2),
          block("b7", 1, 4),
        ],
        attempts: 0,
      } as unknown as Schema.Json)
    }
    return Promise.resolve(undefined)
  },
  set: () => Promise.resolve(),
  remove: () => Promise.resolve(),
} as StorageLike

describe("resolveDecompress（集成）", () => {
  it("缺 block 参数返回失败", async () => {
    const result = await resolveDecompress({}, { storage }, "ses_x")
    expect(result.status).toBe("error")
    if (result.status === "error") expect(result.message).toContain("block")
  })

  it("未知块返回失败", async () => {
    const result = await resolveDecompress({ block: "b999" }, { storage }, "ses_x")
    expect(result.status).toBe("error")
    if (result.status === "error") expect(result.message).toContain("not found")
  })

  it("T2 块 full:false 返回直接子块摘要", async () => {
    const result = await resolveDecompress({ block: "b5" }, { storage }, "ses_x")
    expect(result.status).toBe("ok")
    if (result.status === "ok") {
      expect(result.inline).toContain("title b1")
      expect(result.inline).toContain("title b2")
      expect(result.path).toBeUndefined()
    }
  })

  it("T3 块 full:false 返回 T2 子块摘要", async () => {
    const result = await resolveDecompress({ block: "b3" }, { storage }, "ses_x")
    expect(result.status).toBe("ok")
    if (result.status === "ok") {
      expect(result.inline).toContain("title b5")
      expect(result.inline).toContain("title b6")
    }
  })

  it("full:true 时 DB 不可达则标注原文不可用，不报错", async () => {
    const result = await resolveDecompress({ block: "b3", full: true }, { storage }, "ses_x")
    expect(result.status).toBe("ok")
    if (result.status === "ok") {
      expect(result.inline).toContain("unavailable")
    }
  })
})
