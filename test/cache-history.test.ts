import type { Plugin } from "@opencode/plugin"
import type { Schema } from "effect"
import { describe, expect, it } from "vitest"

import { type CacheMessage, type CacheSample } from "../src/cache.ts"
import { loadCacheHistory, recordCacheHistory, saveCacheHistory } from "../src/compression/cache-history.ts"
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

/** 输入：id + 时间；输出：合法样本。 */
function sample(id: string, at: number): CacheSample {
  return { messageID: id, at, input: 100, output: 10, cached: 80, hitRate: 80 }
}

/** 输入：id + 时间；输出：带 usage 的 assistant 消息。 */
function message(id: string, at: number): CacheMessage {
  return {
    id,
    type: "assistant",
    time: { created: at },
    tokens: { input: 20, output: 5, reasoning: 0, cache: { read: 70, write: 10 } },
  }
}

/** 输入：消息表 + storage；输出：最小插件上下文替身。 */
function createContext(
  messages: ReadonlyMap<string, readonly CacheMessage[]>,
  storage: StorageLike,
): Plugin.Context {
  return {
    storage,
    session: {
      context: ({ sessionID }: { sessionID: string }) =>
        Promise.resolve(messages.get(sessionID) ?? []),
    },
  } as unknown as Plugin.Context
}

describe("loadCacheHistory / saveCacheHistory", () => {
  it("写入后能读回，缺失会话是空历史", async () => {
    const storage = createStorage()
    await saveCacheHistory(storage, "ses_a", [sample("m1", 10)])
    expect((await loadCacheHistory(storage, "ses_a")).samples).toEqual([sample("m1", 10)])
    expect((await loadCacheHistory(storage, "ses_b")).samples).toEqual([])
  })

  it("不同会话的历史互相隔离", async () => {
    const storage = createStorage()
    await saveCacheHistory(storage, "ses_a", [sample("a1", 10), sample("a2", 20)])
    await saveCacheHistory(storage, "ses_b", [sample("b1", 30)])
    expect((await loadCacheHistory(storage, "ses_a")).samples.map((item) => item.messageID)).toEqual([
      "a1",
      "a2",
    ])
    expect((await loadCacheHistory(storage, "ses_b")).samples.map((item) => item.messageID)).toEqual([
      "b1",
    ])
  })
})

describe("recordCacheHistory", () => {
  it("把当前上下文里的 assistant usage 追加进对应会话", async () => {
    const storage = createStorage()
    const ctx = createContext(
      new Map([["ses_a", [message("m1", 10), message("m2", 20)]]]),
      storage,
    )
    await recordCacheHistory(ctx, "ses_a")
    const history = await loadCacheHistory(storage, "ses_a")
    expect(history.samples).toHaveLength(2)
    expect(history.samples.map((item) => item.messageID)).toEqual(["m1", "m2"])
    expect(history.samples[0]?.hitRate).toBe(70)
  })

  it("重复记录同一批消息不会重复追加", async () => {
    const storage = createStorage()
    const ctx = createContext(new Map([["ses_a", [message("m1", 10)]]]), storage)
    await recordCacheHistory(ctx, "ses_a")
    await recordCacheHistory(ctx, "ses_a")
    expect((await loadCacheHistory(storage, "ses_a")).samples).toHaveLength(1)
  })

  it("超过 10 条只保留最新 10 条", async () => {
    const storage = createStorage()
    const messages = Array.from({ length: 15 }, (_, index) => message(`m${index.toString()}`, index))
    const ctx = createContext(new Map([["ses_a", messages]]), storage)
    await recordCacheHistory(ctx, "ses_a")
    const history = await loadCacheHistory(storage, "ses_a")
    expect(history.samples).toHaveLength(10)
    expect(history.samples[0]?.messageID).toBe("m5")
    expect(history.samples.at(-1)?.messageID).toBe("m14")
  })

  it("不会把别的会话的消息写进来", async () => {
    const storage = createStorage()
    const ctx = createContext(
      new Map([
        ["ses_a", [message("a1", 10)]],
        ["ses_b", [message("b1", 20)]],
      ]),
      storage,
    )
    await recordCacheHistory(ctx, "ses_a")
    await recordCacheHistory(ctx, "ses_b")
    expect((await loadCacheHistory(storage, "ses_a")).samples.map((item) => item.messageID)).toEqual([
      "a1",
    ])
    expect((await loadCacheHistory(storage, "ses_b")).samples.map((item) => item.messageID)).toEqual([
      "b1",
    ])
  })
})
