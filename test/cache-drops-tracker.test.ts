import { describe, expect, it } from "vitest"

import { createDropTracker, planCacheDrop } from "../src/compression/cache-drops.ts"
import type { CacheSample } from "../src/shared/cache.ts"

/** 输入：命中率与 id；输出：缓存样本；用于构造相邻两条样本。 */
function sample(messageID: string, hitRate: number, at = 1): CacheSample {
  return { messageID, at, input: 100, output: 10, cached: hitRate, hitRate }
}

/** 输入：system 文本；输出：原始请求体；用于构造有/无断点的两份报文。 */
function request(system: string): string {
  return JSON.stringify({ model: "m", system, messages: [{ role: "user", content: "hi" }] })
}

describe("DropTracker", () => {
  it("同一会话後一次 capture 覆盖前一次（重试只留最后一个报文）", () => {
    const tracker = createDropTracker()
    tracker.capture("s1", { body: request("old"), at: 1, kind: "primary" })
    tracker.capture("s1", { body: request("new"), at: 2, kind: "primary" })
    const pair = tracker.consume("s1", "msg_1")
    expect(pair.current?.body).toBe(request("new"))
    expect(pair.previous).toBeUndefined()
  })

  it("第一次 consume 没有 previous，第二次才拿到上一轮报文并补上 messageID", () => {
    const tracker = createDropTracker()
    tracker.capture("s1", { body: request("a"), at: 1, kind: "primary" })
    const first = tracker.consume("s1", "msg_1")
    expect(first.previous).toBeUndefined()

    tracker.capture("s1", { body: request("b"), at: 2, kind: "primary" })
    const second = tracker.consume("s1", "msg_2")
    expect(second.previous?.body).toBe(request("a"))
    expect(second.previous?.messageID).toBe("msg_1")
    expect(second.current?.body).toBe(request("b"))
  })

  it("本轮没抓到报文时消费仍推进 previous，但绝不用两个不相邻报文对比", () => {
    const tracker = createDropTracker()
    tracker.capture("s1", { body: request("a"), at: 1, kind: "primary" })
    tracker.consume("s1", "msg_1")

    // 这一轮没有 http.request（例如走了别的传输路径）。
    const empty = tracker.consume("s1", "msg_2")
    expect(empty.current).toBeUndefined()
    // previous 仍是 msg_1，不会退化成 msg_2。
    expect(empty.previous?.messageID).toBe("msg_1")
  })

  it("超长报文原样保留，不截断", () => {
    const tracker = createDropTracker()
    const long = "x".repeat(8 * 1024 * 1024 + 1)
    tracker.capture("s1", { body: long, at: 1, kind: "primary" })
    expect(tracker.consume("s1", "msg_1").current?.body.length).toBe(long.length)
  })

  it("clearPending 只丢弃没等到 usage 的报文，保留上一份用于跨回合对比", () => {
    const tracker = createDropTracker()
    tracker.capture("s1", { body: request("a"), at: 1, kind: "primary" })
    tracker.consume("s1", "msg_1")
    tracker.capture("s1", { body: request("b"), at: 2, kind: "primary" })
    tracker.clearPending("s1")
    const pair = tracker.consume("s1", "msg_2")
    expect(pair.current).toBeUndefined()
    expect(pair.previous?.messageID).toBe("msg_1")
  })

  it("forget 清掉某会话全部状态，不影响其它会话", () => {
    const tracker = createDropTracker()
    tracker.capture("s1", { body: request("a"), at: 1, kind: "primary" })
    tracker.capture("s2", { body: request("b"), at: 1, kind: "primary" })
    tracker.consume("s2", "msg_2")
    tracker.forget("s1")
    expect(tracker.consume("s1", "msg_1").current).toBeUndefined()
    expect(tracker.consume("s2", "msg_3").previous?.messageID).toBe("msg_2")
  })

  it("两个会话交错抓取/消费时绝不串台", () => {
    const tracker = createDropTracker()
    tracker.capture("s1", { body: request("s1-a"), at: 1, kind: "primary" })
    tracker.capture("s2", { body: request("s2-a"), at: 1, kind: "primary" })
    expect(tracker.consume("s1", "s1-msg1").current?.body).toBe(request("s1-a"))
    expect(tracker.consume("s2", "s2-msg1").current?.body).toBe(request("s2-a"))

    tracker.capture("s1", { body: request("s1-b"), at: 2, kind: "primary" })
    tracker.capture("s2", { body: request("s2-b"), at: 2, kind: "primary" })
    const first = tracker.consume("s1", "s1-msg2")
    const second = tracker.consume("s2", "s2-msg2")
    expect(first.previous?.body).toBe(request("s1-a"))
    expect(first.previous?.messageID).toBe("s1-msg1")
    expect(second.previous?.body).toBe(request("s2-a"))
    expect(second.previous?.messageID).toBe("s2-msg1")
  })

  it("同目录父会话与子代理会话各自独立配对", () => {
    const tracker = createDropTracker()
    tracker.capture("ses_parent", { body: request("parent"), at: 1, kind: "primary" })
    tracker.capture("ses_child", { body: request("child"), at: 1, kind: "primary" })
    tracker.consume("ses_parent", "parent-m1")
    tracker.consume("ses_child", "child-m1")

    tracker.capture("ses_child", { body: request("child2"), at: 2, kind: "primary" })
    const childPair = tracker.consume("ses_child", "child-m2")
    expect(childPair.previous?.body).toBe(request("child"))
    // 父会话没有被推进，它的上一轮仍是 parent-m1。
    const parentPair = tracker.consume("ses_parent", "parent-m2")
    expect(parentPair.previous?.messageID).toBe("parent-m1")
  })
})

describe("planCacheDrop 的对比判定", () => {
  /** 输入：tracker + 两轮报文；输出：可直接交给 planCacheDrop 的报文对。 */
  function pairOf(previousBody: string, currentBody: string, firstID = "msg_1", secondID = "msg_2") {
    const tracker = createDropTracker()
    tracker.capture("s1", { body: previousBody, at: 1, kind: "primary" })
    tracker.consume("s1", firstID)
    tracker.capture("s1", { body: currentBody, at: 2, kind: "primary" })
    return tracker.consume("s1", secondID)
  }

  it("上一条样本的 messageID 与上一轮报文一致时才做对比", () => {
    const pair = pairOf(request("AAA"), request("AAB"))
    const result = planCacheDrop({
      previousSample: sample("msg_1", 90),
      sample: sample("msg_2", 40),
      pair,
      kind: "primary",
      threshold: 10,
    })
    expect(result?.cause).toBe("system")
    expect(result?.dropPp).toBe(50)
    expect(result?.prevMessageID).toBe("msg_1")
    expect(result?.breakPoint?.segment).toBe("system")
  })

  it("上一轮报文与样本 ID 对不上时仍强制对比上一份报文", () => {
    // previous 报文属于 msg_retry，但缓存样本的上一条是 msg_1（中间有失败/重试）。
    const pair = pairOf(request("AAA"), request("AAB"), "msg_retry")
    const result = planCacheDrop({
      previousSample: sample("msg_1", 90),
      sample: sample("msg_2", 40),
      pair,
      kind: "primary",
      threshold: 10,
    })
    expect(result?.cause).toBe("system")
    expect(result?.breakPoint?.segment).toBe("system")
    expect(result?.prevMessageID).toBe("msg_1")
  })

  it("没有上一轮报文时记 unknown，但仍保存当前请求原文", () => {
    const tracker = createDropTracker()
    tracker.capture("s1", { body: request("AAB"), at: 2, kind: "primary" })
    const pair = tracker.consume("s1", "msg_2")
    const result = planCacheDrop({
      previousSample: sample("msg_1", 90),
      sample: sample("msg_2", 40),
      pair,
      kind: "primary",
      threshold: 10,
    })
    expect(result?.cause).toBe("unknown")
    expect(result?.breakPoint).toBeUndefined()
    expect(result?.outline?.length).toBeGreaterThan(0)
    expect(result?.request?.text).toContain("AAB")
  })

  it("跌幅未达阈值时不记录", () => {
    const pair = pairOf(request("AAA"), request("AAB"))
    const result = planCacheDrop({
      previousSample: sample("msg_1", 90),
      sample: sample("msg_2", 85),
      pair,
      kind: "primary",
      threshold: 10,
    })
    expect(result).toBeUndefined()
  })

  it("命中率上升不记录", () => {
    const pair = pairOf(request("AAA"), request("AAB"))
    const result = planCacheDrop({
      previousSample: sample("msg_1", 40),
      sample: sample("msg_2", 90),
      pair,
      kind: "primary",
      threshold: 10,
    })
    expect(result).toBeUndefined()
  })

  it("只追加新消息（前缀没变）时记录 append 且不含断点", () => {
    const previousBody = JSON.stringify({ model: "m", messages: [{ role: "user", content: "a" }] })
    const currentBody = JSON.stringify({
      model: "m",
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
      ],
    })
    const pair = pairOf(previousBody, currentBody)
    const result = planCacheDrop({
      previousSample: sample("msg_1", 90),
      sample: sample("msg_2", 40),
      pair,
      kind: "primary",
      threshold: 10,
    })
    expect(result?.cause).toBe("append")
    expect(result?.breakPoint).toBeUndefined()
    expect(result?.request?.segment).toBe("request")
  })
})
