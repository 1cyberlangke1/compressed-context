import { existsSync, readFileSync } from "node:fs"

import type { Plugin } from "@opencode/plugin"
import type { Schema } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { deleteSessionTempFiles, resolveDecompress } from "../src/compression/decompress.ts"
import { forgetSession } from "../src/compression/events.ts"
import { clearDeletedSessions, markSessionDeleted } from "../src/compression/deleted-sessions.ts"
import type { MessageLike } from "../src/compression/select.ts"
import { saveState, type Block, type StorageLike } from "../src/compression/state.ts"
import {
  deleteTranscriptsForSession,
  loadTranscriptManifest,
  loadTranscriptMessage,
  saveTranscript,
  transcriptManifestKey,
  transcriptMessageKey,
} from "../src/compression/transcript-store.ts"

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

/** 输入：无；输出：带 scan 的磁盘替身。 */
function createStorage(): StorageLike & {
  readonly data: Map<string, Schema.Json>
  scan(options: { prefix: string; limit: number; after?: string }): Promise<{
    entries: readonly { key: string; value: Schema.Json }[]
    next?: string
  }>
} {
  const data = new Map<string, Schema.Json>()
  return {
    data,
    get: (key) => Promise.resolve(data.get(key)),
    set: (key, value) => {
      data.set(key, value)
      return Promise.resolve()
    },
    remove: (key) => {
      data.delete(key)
      return Promise.resolve()
    },
    scan: (options) => {
      const keys = [...data.keys()].filter((key) => key.startsWith(options.prefix)).sort()
      const after = options.after
      const start = after === undefined ? 0 : keys.findIndex((key) => key > after) + 1
      const slice = keys.slice(start, start + options.limit)
      const next = start + options.limit < keys.length ? slice.at(-1) : undefined
      return Promise.resolve({
        entries: slice.map((key) => ({ key, value: data.get(key) as Schema.Json })),
        ...(next === undefined ? {} : { next }),
      })
    },
  }
}

/** 输入：id/范围；输出：测试块。 */
function block(id: string, fromId: string, toId: string): Block {
  return {
    id,
    tier: 1,
    depth: 1,
    summary: { ...summary, title: id },
    fromId,
    toId,
    sourceTokens: 1,
    summaryTokens: 1,
    at: 1,
    order: 1,
  }
}

/** 输入：文本；输出：user 消息。 */
function user(id: string, text: string): MessageLike {
  return { id, role: "user", content: [{ type: "text", text }] }
}

afterEach(() => {
  clearDeletedSessions()
})

describe("transcript store", () => {
  it("保存并读回文本、base64 媒体，跳过 reasoning", async () => {
    const storage = createStorage()
    const messages: MessageLike[] = [
      user("m1", "hello"),
      {
        id: "m2",
        role: "assistant",
        content: [
          { type: "reasoning", text: "secret" },
          {
            type: "media",
            filename: "x.png",
            media: {
              source: { type: "base64", data: "aGVsbG8=", mediaType: "image/png" },
            },
          },
          {
            type: "media",
            filename: "remote.png",
            media: { source: { type: "url", url: "https://example.com/x.png", mediaType: "image/png" } },
          },
        ],
      },
    ]
    await saveTranscript(storage, "ses_a", block("b1", "m1", "m2"), messages)
    expect(await loadTranscriptManifest(storage, "ses_a", "b1")).toMatchObject({ count: 2 })
    const second = await loadTranscriptMessage(storage, "ses_a", "b1", 1)
    expect(second?.content).toHaveLength(2)
    expect(JSON.stringify(second)).not.toContain("secret")
    expect(JSON.stringify(second)).toContain("aGVsbG8=")
    expect(JSON.stringify(second)).toContain("https://example.com/x.png")
  })

  it("删除会话时清掉全部 manifest/message key", async () => {
    const storage = createStorage()
    await saveTranscript(storage, "ses_a", block("b1", "m1", "m2"), [user("m1", "a"), user("m2", "b")])
    await saveTranscript(storage, "ses_a", block("b2", "m3", "m4"), [user("m3", "c"), user("m4", "d")])
    expect(storage.data.has(transcriptManifestKey("ses_a", "b1"))).toBe(true)
    expect(storage.data.has(transcriptMessageKey("ses_a", "b2", 1))).toBe(true)
    await deleteTranscriptsForSession(storage, "ses_a")
    expect([...storage.data.keys()].filter((key) => key.includes("compression:transcript:ses_a:"))).toEqual([])
  })

  it("forgetSession 删除 state/cache/transcript", async () => {
    const storage = createStorage()
    await saveState(storage, "ses_a", { blocks: [block("b1", "m1", "m2")], attempts: 0 })
    await storage.set("cache:history:ses_a", { v: 1, samples: [] })
    await saveTranscript(storage, "ses_a", block("b1", "m1", "m2"), [user("m1", "a"), user("m2", "b")])
    const ctx = { storage } as unknown as Plugin.Context
    await forgetSession(ctx, "ses_a")
    expect(storage.data.has("compression:state:ses_a")).toBe(false)
    expect(storage.data.has("cache:history:ses_a")).toBe(false)
    expect([...storage.data.keys()].filter((key) => key.includes("compression:transcript:ses_a:"))).toEqual([])
  })

  it("墓碑阻止删除后的迟到写入", async () => {
    const storage = createStorage()
    markSessionDeleted("ses_a")
    await saveTranscript(storage, "ses_a", block("b1", "m1", "m2"), [user("m1", "a")])
    expect(storage.data.size).toBe(0)
    await saveState(storage, "ses_a", { blocks: [], attempts: 0 })
    expect(storage.data.size).toBe(0)
  })
})

describe("decompress from transcript store", () => {
  it("full 模式还原文本与 base64 媒体，并为 url 输出占位符", async () => {
    const storage = createStorage()
    await saveState(storage, "ses_a", { blocks: [block("b1", "m1", "m3")], attempts: 0 })
    await saveTranscript(storage, "ses_a", block("b1", "m1", "m3"), [
      user("m1", "hello"),
      {
        id: "m2",
        role: "assistant",
        content: [
          {
            type: "media",
            filename: "x.png",
            media: { source: { type: "base64", data: "aGVsbG8=", mediaType: "image/png" } },
          },
          {
            type: "media",
            filename: "remote.png",
            media: { source: { type: "url", url: "https://example.com/x.png", mediaType: "image/png" } },
          },
        ],
      },
      user("m3", "bye"),
    ])
    const result = await resolveDecompress({ block: "b1", full: true }, { storage }, "ses_a", {
      inlineMax: 10_000,
      tempCap: 50,
      showTokens: false,
    })
    expect(result.status).toBe("ok")
    if (result.status !== "ok") return
    expect(result.inline).toContain("hello")
    expect(result.inline).toContain("bye")
    expect(result.inline).toContain("saved to:")
    expect(result.inline).toContain("unavailable media")
    const mediaPath = /saved to: (.*?)\]/.exec(result.inline)?.[1]
    expect(mediaPath).toBeDefined()
    if (mediaPath !== undefined) {
      expect(readFileSync(mediaPath, "utf8")).toBe("hello")
      expect(existsSync(mediaPath)).toBe(true)
    }
    deleteSessionTempFiles("ses_a")
    if (mediaPath !== undefined) expect(existsSync(mediaPath)).toBe(false)
  })

  it("T2/T3 full=true 仍然递归还原 T1 原文，full=false 只展开一层", async () => {
    const storage = createStorage()
    const b1 = block("b1", "m1", "m2")
    const b2 = block("b2", "m3", "m4")
    const b3: Block = {
      ...block("b3", "m1", "m4"),
      tier: 2,
      order: 2,
      sourceBlockIds: ["b1", "b2"],
    }
    await saveState(storage, "ses_a", { blocks: [b1, b2, b3], attempts: 0 })
    await saveTranscript(storage, "ses_a", b1, [user("m1", "ORIGINAL_ONE"), user("m2", "ORIGINAL_TWO")])
    await saveTranscript(storage, "ses_a", b2, [user("m3", "ORIGINAL_THREE"), user("m4", "ORIGINAL_FOUR")])

    const shallow = await resolveDecompress({ block: "b3", full: false }, { storage }, "ses_a")
    expect(shallow.status).toBe("ok")
    if (shallow.status === "ok") {
      expect(shallow.inline).toContain("section #b1")
      expect(shallow.inline).toContain("section #b2")
      expect(shallow.inline).not.toContain("ORIGINAL_ONE")
    }

    const deep = await resolveDecompress({ block: "b3", full: true }, { storage }, "ses_a")
    expect(deep.status).toBe("ok")
    if (deep.status === "ok") {
      expect(deep.inline).toContain("ORIGINAL_ONE")
      expect(deep.inline).toContain("ORIGINAL_THREE")
    }
  })

  it("没有 transcript 时输出 unavailable 占位符", async () => {
    const storage = createStorage()
    await saveState(storage, "ses_a", { blocks: [block("b1", "m1", "m2")], attempts: 0 })
    const result = await resolveDecompress({ block: "b1", full: true }, { storage }, "ses_a")
    expect(result.status).toBe("ok")
    if (result.status === "ok") expect(result.inline).toContain("unavailable")
  })
})
