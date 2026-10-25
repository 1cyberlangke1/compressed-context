import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"
import type { Schema } from "effect"

import { resolveDecompress } from "../src/compression/decompress.ts"
import type { Block, StorageLike } from "../src/compression/state.ts"
import { createTempFileStore } from "../src/compression/temp-files.ts"

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
  depth: tier,
  summary: { ...summary, title: `title ${id}` },
  fromId: `${id}-from`,
  toId: `${id}-to`,
  sourceTokens: 100,
  summaryTokens: 10,
  at: order,
  order,
  ...(sourceIds === undefined ? {} : { sourceBlockIds: sourceIds }),
})

const storage = {
  get: (key: string) => {
    if (key.endsWith("ses_x")) {
      return Promise.resolve({
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

  it("depth:2 从 T3 下探两层，碰到 T1 读转录（无转录时占位符）", async () => {
    // b3(T3) → b5/b6(T2) → b1/b2/b7(T1)：depth 2 允许下探到 T2 的子块层。
    const result = await resolveDecompress({ block: "b3", depth: 2 }, { storage }, "ses_x", {
      inlineMax: 10_000,
      tempCap: 50,
      showTokens: false,
    })
    expect(result.status).toBe("ok")
    if (result.status === "ok") {
      // T1 已到达：内容来自转录（这里 storage 没有转录 → 占位符）。
      expect(result.inline).toContain("original transcript")
      expect(result.inline).toContain("depth 2")
    }
  })

  it("depth 超过塔深时停在 T1，不报错", async () => {
    const result = await resolveDecompress({ block: "b5", depth: 9 }, { storage }, "ses_x", {
      inlineMax: 10_000,
      tempCap: 50,
      showTokens: false,
    })
    expect(result.status).toBe("ok")
  })

  it("depth:0 与非正整数报参数错", async () => {
    for (const depth of [0, -1, 1.5]) {
      const result = await resolveDecompress({ block: "b5", depth }, { storage }, "ses_x")
      expect(result.status).toBe("error")
      if (result.status === "error") expect(result.message).toContain("depth")
    }
  })

  it("depth 超过硬上限报错", async () => {
    const result = await resolveDecompress({ block: "b5", depth: 21 }, { storage }, "ses_x")
    expect(result.status).toBe("error")
    if (result.status === "error") expect(result.message).toContain("at most")
  })

  it("full 与 depth 同给时 full 优先", async () => {
    const result = await resolveDecompress({ block: "b3", full: true, depth: 1 }, { storage }, "ses_x")
    expect(result.status).toBe("ok")
    if (result.status === "ok") expect(result.inline).toContain("full")
  })

  it("token 估算可开关", async () => {
    const withTokens = await resolveDecompress({ block: "b5" }, { storage }, "ses_x", {
      inlineMax: 10_000,
      tempCap: 50,
      showTokens: true,
    })
    expect(withTokens.status).toBe("ok")
    if (withTokens.status === "ok") {
      expect(withTokens.inline).toContain("≈")
      expect(withTokens.inline).toContain("tok")
      expect(typeof withTokens.tokens).toBe("number")
    }

    const without = await resolveDecompress({ block: "b5" }, { storage }, "ses_x", {
      inlineMax: 10_000,
      tempCap: 50,
      showTokens: false,
    })
    expect(without.status).toBe("ok")
    if (without.status === "ok") expect(without.inline).not.toContain("≈")
  })

  it("超过内联上限时写临时文件", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cc-decompress-test-"))
    try {
      const result = await resolveDecompress({ block: "b5" }, { storage }, "ses_x", {
        inlineMax: 10,
        tempCap: 50,
        showTokens: true,
        tempFiles: createTempFileStore({ directory }),
      })
      expect(result.status).toBe("ok")
      if (result.status === "ok") {
        expect(result.path).toBeDefined()
        expect(result.inline).toContain("written to")
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
