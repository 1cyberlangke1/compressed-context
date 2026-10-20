import { describe, expect, it } from "vitest"

import {
  CACHE_HISTORY_LIMIT,
  appendCacheSamples,
  cacheHistoryEquals,
  cacheHistoryKey,
  parseCacheHistory,
  sampleFromMessage,
  type CacheMessage,
  type CacheSample,
} from "../src/shared/cache.ts"

/** 输入：id + usage；输出：带 tokens 的 assistant 消息。 */
function assistant(
  id: string,
  at: number,
  tokens: {
    input: number
    output: number
    reasoning?: number
    read: number
    write: number
  },
): CacheMessage {
  return {
    id,
    type: "assistant",
    time: { created: at },
    tokens: {
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning ?? 0,
      cache: { read: tokens.read, write: tokens.write },
    },
  }
}

/** 输入：id；输出：合法样本。 */
function sample(id: string, at: number): CacheSample {
  return { messageID: id, at, input: 100, output: 10, cached: 80, hitRate: 80 }
}

describe("cacheHistoryKey", () => {
  it("按会话隔离", () => {
    expect(cacheHistoryKey("ses_a")).toBe("cache:history:ses_a")
    expect(cacheHistoryKey("ses_a")).not.toBe(cacheHistoryKey("ses_b"))
  })
})

describe("sampleFromMessage", () => {
  it("计算输入、输出、缓存与命中率", () => {
    const message = assistant("m1", 1_000, { input: 20, output: 10, reasoning: 5, read: 70, write: 10 })
    expect(sampleFromMessage(message, 0)).toEqual({
      messageID: "m1",
      at: 1_000,
      input: 100,
      output: 15,
      cached: 70,
      hitRate: 70,
    })
  })

  it("输入为 0 时命中率为 0", () => {
    const message = assistant("m1", 1_000, { input: 0, output: 10, read: 0, write: 0 })
    expect(sampleFromMessage(message, 0)?.hitRate).toBe(0)
  })

  it("非 assistant 或缺 tokens 返回 undefined", () => {
    expect(sampleFromMessage({ id: "u1", type: "user" }, 0)).toBeUndefined()
    expect(sampleFromMessage({ id: "a1", type: "assistant" }, 0)).toBeUndefined()
  })

  it("缺时间时用回退值", () => {
    const message: CacheMessage = {
      id: "m1",
      type: "assistant",
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 1, write: 0 } },
    }
    expect(sampleFromMessage(message, 42)?.at).toBe(42)
  })
})

describe("appendCacheSamples", () => {
  it("按 messageID 去重", () => {
    const message = assistant("m1", 1_000, { input: 10, output: 1, read: 8, write: 0 })
    const first = appendCacheSamples([], [message], 0)
    const second = appendCacheSamples(first, [message], 0)
    expect(second).toHaveLength(1)
    expect(second[0]?.messageID).toBe("m1")
  })

  it("只保留最新 10 条，旧的被丢弃", () => {
    const messages = Array.from({ length: 15 }, (_, index) =>
      assistant(`m${index.toString()}`, index, { input: 10, output: 1, read: 8, write: 0 }),
    )
    const samples = appendCacheSamples([], messages, 0)
    expect(samples).toHaveLength(CACHE_HISTORY_LIMIT)
    expect(samples[0]?.messageID).toBe("m5")
    expect(samples.at(-1)?.messageID).toBe("m14")
  })

  it("乱序消息按时间升序排列", () => {
    const samples = appendCacheSamples(
      [],
      [
        assistant("late", 30, { input: 10, output: 1, read: 8, write: 0 }),
        assistant("early", 10, { input: 10, output: 1, read: 8, write: 0 }),
      ],
      0,
    )
    expect(samples.map((sample) => sample.messageID)).toEqual(["early", "late"])
  })

  it("已有历史里的旧样本不会被重复追加", () => {
    const existing = [sample("m1", 10)]
    const samples = appendCacheSamples(
      existing,
      [
        assistant("m1", 10, { input: 100, output: 10, read: 80, write: 0 }),
        assistant("m2", 20, { input: 100, output: 10, read: 80, write: 0 }),
      ],
      0,
    )
    expect(samples.map((item) => item.messageID)).toEqual(["m1", "m2"])
    expect(samples[0]).toEqual(existing[0])
  })
})

describe("parseCacheHistory", () => {
  it("解析合法历史", () => {
    const value = { v: 1, samples: [sample("m1", 10)] }
    expect(parseCacheHistory(value)).toEqual(value)
  })

  it("坏数据返回空历史", () => {
    expect(parseCacheHistory(undefined)).toEqual({ v: 1, samples: [] })
    expect(parseCacheHistory(null)).toEqual({ v: 1, samples: [] })
    expect(parseCacheHistory({ v: 2, samples: [] })).toEqual({ v: 1, samples: [] })
    expect(parseCacheHistory({ v: 1, samples: "no" })).toEqual({ v: 1, samples: [] })
  })

  it("丢弃非法样本并截断到 10 条", () => {
    const samples = Array.from({ length: 15 }, (_, index) => sample(`m${index.toString()}`, index))
    const parsed = parseCacheHistory({
      v: 1,
      samples: [
        ...samples,
        { messageID: "", at: 1, input: 1, output: 1, cached: 1, hitRate: 1 },
        { messageID: "bad", at: 1, input: -1, output: 1, cached: 1, hitRate: 1 },
        { messageID: "bad2", at: 1, input: 1, output: 1, cached: 1, hitRate: 101 },
      ],
    })
    expect(parsed.samples).toHaveLength(CACHE_HISTORY_LIMIT)
    expect(parsed.samples.at(-1)?.messageID).toBe("m14")
  })

  it("重复 messageID 只保留第一条", () => {
    const parsed = parseCacheHistory({
      v: 1,
      samples: [
        { messageID: "m1", at: 10, input: 1, output: 1, cached: 1, hitRate: 100 },
        { messageID: "m1", at: 20, input: 2, output: 2, cached: 2, hitRate: 100 },
      ],
    })
    expect(parsed.samples).toHaveLength(1)
    expect(parsed.samples[0]?.at).toBe(10)
  })
})

describe("cacheHistoryEquals", () => {
  it("内容一致返回 true，不一致返回 false", () => {
    expect(cacheHistoryEquals([sample("m1", 10)], [sample("m1", 10)])).toBe(true)
    expect(cacheHistoryEquals([sample("m1", 10)], [sample("m1", 11)])).toBe(false)
    expect(cacheHistoryEquals([], [])).toBe(true)
  })
})
