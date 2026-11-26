import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { Schema } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { loadCacheHistory, recordCacheHistoryStep, recordCacheHistoryUsage } from "../src/compression/cache-history.ts"
import { dropTracker } from "../src/compression/cache-drops.ts"
import { clearDeletedSessions } from "../src/compression/deleted-sessions.ts"
import type { StorageLike } from "../src/compression/state.ts"

/** 输入：无；输出：内存 storage 替身。 */
function createStorage(): StorageLike {
  const data = new Map<string, unknown>()
  return {
    get(key) {
      return Promise.resolve(data.get(key) as Schema.Json | undefined)
    },
    set(key, value) {
      data.set(key, value)
      return Promise.resolve()
    },
    remove(key) {
      data.delete(key)
      return Promise.resolve()
    },
  }
}

/** 输入：项目目录 + 设置片段；输出：最小插件上下文。预期：项目层 JSONC 覆盖全局。 */
function createContext(directory: string, storage: StorageLike): Plugin.Context {
  mkdirSync(join(directory, ".opencode"), { recursive: true })
  return {
    location: { directory },
    storage,
    session: {
      get: () => Promise.resolve(undefined),
      context: () => Promise.resolve([]),
    },
  } as unknown as Plugin.Context
}

/** 输入：项目目录 + 设置；输出：无。预期：把插件 JSONC 写到项目层。 */
function writeSettings(directory: string, settings: Readonly<Record<string, unknown>>): void {
  writeFileSync(join(directory, ".opencode", "compressed-context.json"), JSON.stringify(settings))
}

/** 输入：读/写缓存命中率（千分比）；输出：step usage。 */
function tokens(hitPercent: number): {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
} {
  const prompt = 1_000
  const cached = Math.round((prompt * hitPercent) / 100)
  return { input: prompt - cached, output: 10, reasoning: 0, cache: { read: cached, write: 0 } }
}

/** 输入：system 文本；输出：上游原始请求体。 */
function body(system: string): string {
  return JSON.stringify({ model: "m", system, messages: [{ role: "user", content: "hi" }] })
}

/** 每个测试用独立项目目录，避免 JSONC 的 1 秒缓存串味。 */
function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "cc-drops-"))
}

afterEach(() => {
  clearDeletedSessions()
})

describe("recordCacheHistoryStep 的缓存突变记录", () => {
  it("命中率跌幅达到阈值时记录断点，并与上一份报文对比", async () => {
    const directory = tempProject()
    const storage = createStorage()
    const ctx = createContext(directory, storage)
    writeSettings(directory, { cacheDropsEnabled: true, cacheDropsThreshold: 10, cacheDropsMaxRecords: 100 })
    const tracker = dropTracker()
    tracker.forget("ses_a")

    tracker.capture("ses_a", { body: body("AAA"), at: 1, kind: "primary" })
    await recordCacheHistoryStep(ctx, "ses_a", { messageID: "m1", tokens: tokens(90) })

    tracker.capture("ses_a", { body: body("AAB"), at: 2, kind: "primary" })
    await recordCacheHistoryStep(ctx, "ses_a", { messageID: "m2", tokens: tokens(40) })

    const history = await loadCacheHistory(storage, "ses_a")
    expect(history.samples.map((sample) => sample.messageID)).toEqual(["m1", "m2"])
    expect(history.drops).toHaveLength(1)
    expect(history.drops[0]).toMatchObject({
      messageID: "m2",
      prevMessageID: "m1",
      cause: "system",
      dropPp: 50,
    })
    expect(history.drops[0]?.breakPoint?.segment).toBe("system")
    // 完整报文内联进记录，随 maxRecords LRU 淘汰。
    expect(history.drops[0]?.bodies?.body).toContain("AAB")
    expect(history.drops[0]?.bodies?.previousBody).toContain("AAA")
  })

  it("开关关闭时不抓报文、不写突变记录，但样本照常记录", async () => {
    const directory = tempProject()
    const storage = createStorage()
    const ctx = createContext(directory, storage)
    writeSettings(directory, { cacheDropsEnabled: false })
    const tracker = dropTracker()
    tracker.forget("ses_a")

    tracker.capture("ses_a", { body: body("AAA"), at: 1, kind: "primary" })
    await recordCacheHistoryStep(ctx, "ses_a", { messageID: "m1", tokens: tokens(90) })
    tracker.capture("ses_a", { body: body("AAB"), at: 2, kind: "primary" })
    await recordCacheHistoryStep(ctx, "ses_a", { messageID: "m2", tokens: tokens(40) })

    const history = await loadCacheHistory(storage, "ses_a")
    expect(history.samples).toHaveLength(2)
    expect(history.drops).toEqual([])
    // 关闭时已经清掉该会话状态，后续再开也不会拿陈旧报文硬比。
    expect(tracker.consume("ses_a", "m3").previous).toBeUndefined()
  })

  it("跌幅未达阈值不记录，但配对状态照常推进", async () => {
    const directory = tempProject()
    const storage = createStorage()
    const ctx = createContext(directory, storage)
    writeSettings(directory, { cacheDropsEnabled: true, cacheDropsThreshold: 10 })
    const tracker = dropTracker()
    tracker.forget("ses_a")

    tracker.capture("ses_a", { body: body("AAA"), at: 1, kind: "primary" })
    await recordCacheHistoryStep(ctx, "ses_a", { messageID: "m1", tokens: tokens(90) })
    tracker.capture("ses_a", { body: body("AAB"), at: 2, kind: "primary" })
    await recordCacheHistoryStep(ctx, "ses_a", { messageID: "m2", tokens: tokens(85) })

    tracker.capture("ses_a", { body: body("AAC"), at: 3, kind: "primary" })
    await recordCacheHistoryStep(ctx, "ses_a", { messageID: "m3", tokens: tokens(40) })

    const history = await loadCacheHistory(storage, "ses_a")
    expect(history.drops).toHaveLength(1)
    // m2 虽然没记，但它仍是 m3 的「上一轮」，断点应落在 AAC 与 AAB 之间。
    expect(history.drops[0]?.messageID).toBe("m3")
    expect(history.drops[0]?.prevMessageID).toBe("m2")
  })

  it("中间漏抓报文时仍与上一次抓到的报文对比", async () => {
    const directory = tempProject()
    const storage = createStorage()
    const ctx = createContext(directory, storage)
    writeSettings(directory, { cacheDropsEnabled: true, cacheDropsThreshold: 10 })
    const tracker = dropTracker()
    tracker.forget("ses_a")

    tracker.capture("ses_a", { body: body("AAA"), at: 1, kind: "primary" })
    await recordCacheHistoryStep(ctx, "ses_a", { messageID: "m1", tokens: tokens(90) })
    // m2 这一轮没抓到报文（例如走了别的传输路径），跌幅也没到阈值。
    await recordCacheHistoryStep(ctx, "ses_a", { messageID: "m2", tokens: tokens(85) })

    tracker.capture("ses_a", { body: body("AAC"), at: 3, kind: "primary" })
    await recordCacheHistoryStep(ctx, "ses_a", { messageID: "m3", tokens: tokens(40) })

    const history = await loadCacheHistory(storage, "ses_a")
    expect(history.drops).toHaveLength(1)
    expect(history.drops[0]).toMatchObject({ messageID: "m3", prevMessageID: "m2", cause: "system" })
    expect(history.drops[0]?.breakPoint?.segment).toBe("system")
  })

  it("同目录父会话与子代理会话的记录完全隔离", async () => {
    const directory = tempProject()
    const storage = createStorage()
    const ctx = createContext(directory, storage)
    writeSettings(directory, { cacheDropsEnabled: true, cacheDropsThreshold: 10 })
    const tracker = dropTracker()
    tracker.forget("ses_parent")
    tracker.forget("ses_child")

    tracker.capture("ses_parent", { body: body("parent-A"), at: 1, kind: "primary" })
    tracker.capture("ses_child", { body: body("child-A"), at: 1, kind: "primary" })
    await recordCacheHistoryStep(ctx, "ses_parent", { messageID: "p1", tokens: tokens(90) })
    await recordCacheHistoryStep(ctx, "ses_child", { messageID: "c1", tokens: tokens(90) })

    tracker.capture("ses_parent", { body: body("parent-B"), at: 2, kind: "primary" })
    tracker.capture("ses_child", { body: body("child-B"), at: 2, kind: "primary" })
    await recordCacheHistoryStep(ctx, "ses_parent", { messageID: "p2", tokens: tokens(40) })
    await recordCacheHistoryStep(ctx, "ses_child", { messageID: "c2", tokens: tokens(40) })

    const parent = await loadCacheHistory(storage, "ses_parent")
    const child = await loadCacheHistory(storage, "ses_child")
    expect(parent.samples.map((sample) => sample.messageID)).toEqual(["p1", "p2"])
    expect(child.samples.map((sample) => sample.messageID)).toEqual(["c1", "c2"])
    expect(parent.drops.map((drop) => drop.messageID)).toEqual(["p2"])
    expect(child.drops.map((drop) => drop.messageID)).toEqual(["c2"])
  })

  it("两个会话交错记录时不会把对方的报文当成上一轮", async () => {
    const directory = tempProject()
    const storage = createStorage()
    const ctx = createContext(directory, storage)
    writeSettings(directory, { cacheDropsEnabled: true, cacheDropsThreshold: 10 })
    const tracker = dropTracker()
    tracker.forget("ses_a")
    tracker.forget("ses_b")

    tracker.capture("ses_a", { body: body("a-1"), at: 1, kind: "primary" })
    await recordCacheHistoryStep(ctx, "ses_a", { messageID: "a1", tokens: tokens(90) })
    tracker.capture("ses_b", { body: body("b-1"), at: 1, kind: "primary" })
    await recordCacheHistoryStep(ctx, "ses_b", { messageID: "b1", tokens: tokens(90) })

    tracker.capture("ses_a", { body: body("a-2"), at: 2, kind: "primary" })
    await recordCacheHistoryStep(ctx, "ses_a", { messageID: "a2", tokens: tokens(40) })
    tracker.capture("ses_b", { body: body("b-2"), at: 2, kind: "primary" })
    await recordCacheHistoryStep(ctx, "ses_b", { messageID: "b2", tokens: tokens(40) })

    const a = await loadCacheHistory(storage, "ses_a")
    const b = await loadCacheHistory(storage, "ses_b")
    expect(a.drops[0]?.breakPoint?.before).toContain("a-1")
    expect(b.drops[0]?.breakPoint?.before).toContain("b-1")
  })

  it("压缩 / generate 等非主请求同样记录，并带上请求类型", async () => {
    const directory = tempProject()
    const storage = createStorage()
    const ctx = createContext(directory, storage)
    writeSettings(directory, { cacheDropsEnabled: true, cacheDropsThreshold: 10 })
    const tracker = dropTracker()
    tracker.forget("ses_a")

    tracker.capture("ses_a", { body: body("primary-A"), at: 1, kind: "primary" })
    await recordCacheHistoryStep(ctx, "ses_a", { messageID: "m1", tokens: tokens(90) })

    // 第一次摘要请求：跨类型也强制与上一份报文对比。
    tracker.capture("ses_a", { body: body("summary-A"), at: 2, kind: "generate" })
    await recordCacheHistoryUsage(ctx, "ses_a", {
      sampleID: "generate:1",
      kind: "generate",
      tokens: tokens(70),
      model: "fake/model",
    })

    // 第二次摘要请求：同类型相邻，可以对比 system 前缀。
    tracker.capture("ses_a", { body: body("summary-B"), at: 3, kind: "generate" })
    await recordCacheHistoryUsage(ctx, "ses_a", {
      sampleID: "generate:2",
      kind: "generate",
      tokens: tokens(30),
      model: "fake/model",
    })

    const history = await loadCacheHistory(storage, "ses_a")
    expect(history.samples.map((sample) => sample.messageID)).toEqual(["m1", "generate:1", "generate:2"])
    expect(history.drops).toHaveLength(2)
    expect(history.drops[0]).toMatchObject({
      messageID: "generate:1",
      kind: "generate",
      cause: "system",
      model: "fake/model",
    })
    expect(history.drops[0]?.outline?.some((segment) => segment.key === "system")).toBe(true)
    expect(history.drops[0]?.request?.segment).toBe("system")
    expect(history.drops[1]).toMatchObject({
      messageID: "generate:2",
      kind: "generate",
      cause: "system",
      model: "fake/model",
      dropPp: 40,
    })
    expect(history.drops[1]?.request?.segment).toBe("system")
  })

  it("跨请求类型也强制对比上一份报文，仍然落盘", async () => {
    const directory = tempProject()
    const storage = createStorage()
    const ctx = createContext(directory, storage)
    writeSettings(directory, { cacheDropsEnabled: true, cacheDropsThreshold: 10 })
    const tracker = dropTracker()
    tracker.forget("ses_a")

    tracker.capture("ses_a", { body: body("primary-A"), at: 1, kind: "primary" })
    await recordCacheHistoryStep(ctx, "ses_a", { messageID: "m1", tokens: tokens(90) })

    // 上一份抓到的报文是主对话请求，压缩请求仍与它对比。
    tracker.capture("ses_a", { body: body("compaction-A"), at: 2, kind: "compaction" })
    await recordCacheHistoryUsage(ctx, "ses_a", {
      sampleID: "compaction:1",
      kind: "compaction",
      tokens: tokens(30),
    })

    const history = await loadCacheHistory(storage, "ses_a")
    expect(history.drops).toHaveLength(1)
    expect(history.drops[0]).toMatchObject({ kind: "compaction", cause: "system" })
    expect(history.drops[0]?.breakPoint?.segment).toBe("system")
  })
})
