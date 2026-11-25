import { describe, expect, it } from "vitest"

import {
  appendCacheDrop,
  cacheDropsEqual,
  diffRequests,
  dropPercent,
  parseCacheDrops,
  type CacheDrop,
} from "../src/shared/cache-drops.ts"

/** 输入：任意值；输出：JSON 文本；用于构造上游请求体。 */
function body(value: unknown): string {
  return JSON.stringify(value)
}

/** 输入：消息数组；输出：最小请求体。预期：模拟 Chat Completions 形状。 */
function chat(messages: readonly unknown[], extra: Record<string, unknown> = {}): string {
  return body({ model: "m", messages, ...extra })
}

/** 输入：无；输出：一条合法突变记录。 */
function drop(id: string, at: number): CacheDrop {
  return {
    messageID: id,
    at,
    prevMessageID: `prev-${id}`,
    prompt: 100,
    hit: 40,
    hitRate: 40,
    prevPrompt: 100,
    prevHit: 90,
    prevHitRate: 90,
    dropPp: 50,
    cause: "history",
  }
}

describe("diffRequests", () => {
  it("system 段变化归为 system 并给出断点", () => {
    const result = diffRequests(chat([{ role: "user", content: "hi" }], { system: "AAA" }), chat([{ role: "user", content: "hi" }], { system: "AAB" }))
    expect(result.cause).toBe("system")
    expect(result.breakPoint?.segment).toBe("system")
    expect(result.breakPoint?.offset).toBeGreaterThan(0)
    expect(result.outline.map((segment) => segment.key)).toContain("system")
    expect(result.request?.segment).toBe("system")
    expect(result.request?.text).toContain("AAB")
  })

  it("工具定义变化归为 tools，段号指向具体工具", () => {
    const left = chat([{ role: "user", content: "hi" }], { tools: [{ name: "a" }, { name: "b" }] })
    const right = chat([{ role: "user", content: "hi" }], { tools: [{ name: "a" }, { name: "c" }] })
    const result = diffRequests(left, right)
    expect(result.cause).toBe("tools")
    expect(result.breakPoint?.segment).toBe("tools[1]")
  })

  it("只在尾部追加消息时前缀没变，归为 append", () => {
    const left = chat([{ role: "user", content: "a" }])
    const right = chat([{ role: "user", content: "a" }, { role: "assistant", content: "b" }])
    const result = diffRequests(left, right)
    expect(result.cause).toBe("append")
    expect(result.breakPoint).toBeUndefined()
    expect(result.appended?.segment).toBe("messages[1]")
    expect(result.appended?.after).toContain("b")
  })

  it("两条请求完全相同归为 none", () => {
    const same = chat([{ role: "user", content: "a" }])
    expect(diffRequests(same, same)).toMatchObject({ cause: "none" })
  })

  it("窗口后移（新一轮首条消息是上一轮更靠后的消息）归为 window", () => {
    const left = chat([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ])
    const right = chat([{ role: "user", content: "c" }, { role: "assistant", content: "d" }])
    expect(diffRequests(left, right).cause).toBe("window")
  })

  it("消息内容被就地改写（首条相同）归为 history", () => {
    const left = chat([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ])
    const right = chat([
      { role: "user", content: "a" },
      { role: "assistant", content: "B" },
    ])
    expect(diffRequests(left, right).cause).toBe("history")
  })

  it("这一轮是上一轮前缀（尾部被截掉）归为 history，断点在缺失段起点", () => {
    const left = chat([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ])
    const right = chat([{ role: "user", content: "a" }])
    const result = diffRequests(left, right)
    expect(result.cause).toBe("history")
    expect(result.breakPoint?.segment).toBe("messages[1]")
    expect(result.breakPoint?.offset).toBe(0)
    expect(result.breakPoint?.after).toBe("")
  })

  it("其余顶层参数变化归为 params", () => {
    const left = chat([{ role: "user", content: "a" }], { temperature: 0.1 })
    const right = chat([{ role: "user", content: "a" }], { temperature: 0.7 })
    const result = diffRequests(left, right)
    expect(result.cause).toBe("params")
    expect(result.breakPoint?.segment).toBe("temperature")
  })

  it("键顺序不同但内容一致时不算断点", () => {
    const left = body({ model: "m", messages: [{ role: "user", content: "a" }], temperature: 0.1 })
    const right = body({ temperature: 0.1, messages: [{ role: "user", content: "a" }], model: "m" })
    expect(diffRequests(left, right).cause).toBe("none")
  })

  it("非 JSON 请求体不声称断点", () => {
    expect(diffRequests("not-json", chat([{ role: "user", content: "a" }]))).toMatchObject({ cause: "none" })
  })

  it("摘录按码点切片，不会把 emoji 劈成半个", () => {
    const prefix = "😀".repeat(60)
    const left = chat([{ role: "user", content: prefix + "甲" }])
    const right = chat([{ role: "user", content: prefix + "乙" }])
    const result = diffRequests(left, right)
    const before = result.breakPoint?.before ?? ""
    const after = result.breakPoint?.after ?? ""
    // 摘录里不能出现孤立代理项：逐码点比较长度一致即说明没有截断半个字符。
    expect(Array.from(before).length).toBe(Array.from(after).length)
    expect(before).not.toContain("\uFFFD")
  })
})

describe("dropPercent", () => {
  it("只算跌幅并保留两位小数", () => {
    expect(dropPercent(90, 40)).toBe(50)
    expect(dropPercent(90.555, 40.111)).toBe(50.44)
  })

  it("命中率上升时返回负数", () => {
    expect(dropPercent(40, 90)).toBe(-50)
  })
})

describe("parseCacheDrops", () => {
  it("丢弃非法条目并保留合法条目", () => {
    const valid = drop("m1", 1)
    const value = [valid, { messageID: "m2" }, null, "x", { ...valid, cause: "nope" }]
    expect(parseCacheDrops(value, 100)).toEqual([valid])
  })

  it("按上限只留最新记录", () => {
    const value = [drop("m1", 1), drop("m2", 2), drop("m3", 3)]
    expect(parseCacheDrops(value, 2).map((item) => item.messageID)).toEqual(["m2", "m3"])
  })

  it("非数组返回空", () => {
    expect(parseCacheDrops({}, 100)).toEqual([])
  })
})

describe("appendCacheDrop", () => {
  it("按 messageID 去重并覆盖旧记录", () => {
    const first = drop("m1", 1)
    const retried = { ...drop("m1", 1), dropPp: 20 }
    const result = appendCacheDrop([first], retried, 100)
    expect(result).toEqual([retried])
  })

  it("按时间升序并只留最新 N 条", () => {
    const result = appendCacheDrop([drop("m1", 1), drop("m2", 2)], drop("m3", 3), 2)
    expect(result.map((item) => item.messageID)).toEqual(["m2", "m3"])
  })
})

describe("cacheDropsEqual", () => {
  it("逐条比较 messageID、时间与跌幅", () => {
    expect(cacheDropsEqual([drop("m1", 1)], [drop("m1", 1)])).toBe(true)
    expect(cacheDropsEqual([drop("m1", 1)], [drop("m1", 2)])).toBe(false)
    expect(cacheDropsEqual([drop("m1", 1)], [{ ...drop("m1", 1), dropPp: 10 }])).toBe(false)
  })
})
