import { describe, expect, it } from "vitest"

import { parseServerSettings } from "../src/compression/settings.ts"
import { blockMarker, renderAll, renderBlock } from "../src/compression/render.ts"
import type { SummaryFields } from "../src/compression/schema.ts"
import { eligibleMessages, isCheckpoint, textChars, type MessageLike } from "../src/compression/select.ts"
import { commitPending, dropPending, parseState, withPending, type Block } from "../src/compression/state.ts"
import { summarize } from "../src/compression/summarize.ts"
import { buildTranscript } from "../src/compression/transcript.ts"
import { validateSummary } from "../src/compression/validate.ts"

const summary: SummaryFields = {
  title: "compress core",
  goal: "implement compression",
  constraints: ["no native fallback", "keep history intact"],
  decisions: ["use compaction pipeline — it is the only way to advance history"],
  progress: { completed: ["state"], active: ["tool"], blocked: [] },
  open_items: ["auto trigger later"],
  files: ["src/index.ts — wiring"],
  facts: ["block size limit is 20000 chars", "trigger range is 60 to 95 percent"],
}

const block: Block = {
  id: "b1",
  tier: 1,
  summary,
  fromId: "m1",
  toId: "m9",
  tokensBefore: 1000,
  tokensAfter: 100,
  at: 1,
}

const message = (role: string, text: string, id?: string): MessageLike => ({
  id,
  role,
  content: [{ type: "text", text }],
})

describe("选区", () => {
  it("取最后一条 user 之前、排除 checkpoint", () => {
    const checkpoint = message("user", "<conversation-checkpoint>old summary</conversation-checkpoint>", "m3")
    const messages = [
      message("user", "first", "m1"),
      message("assistant", "reply", "m2"),
      checkpoint,
      message("assistant", "more", "m4"),
      message("user", "current", "m5"),
    ]
    expect(eligibleMessages(messages).map((item) => item.id)).toEqual(["m1", "m2", "m4"])
    expect(isCheckpoint(checkpoint)).toBe(true)
    expect(textChars(eligibleMessages(messages))).toBe(5 + 5 + 4)
  })

  it("没有 user 消息时为空", () => {
    expect(eligibleMessages([message("assistant", "hi")])).toEqual([])
  })
})

describe("状态", () => {
  it("pending 转正与丢弃", () => {
    const state = withPending({ v: 1, blocks: [], attempts: 0 }, block)
    expect(commitPending(state).blocks).toHaveLength(1)
    expect(commitPending(state).pending).toBeUndefined()
    expect(dropPending(state, "boom")).toMatchObject({ attempts: 1, lastError: "boom" })
    expect(dropPending(state, "boom").blocks).toHaveLength(0)
  })

  it("损坏的状态回退为空", () => {
    expect(parseState(undefined)).toEqual({ v: 1, blocks: [], attempts: 0 })
    expect(parseState({ v: 2 })).toEqual({ v: 1, blocks: [], attempts: 0 })
    expect(parseState({ v: 1, blocks: [{}] }).blocks).toEqual([])
  })

  it("旧块缺少标题时用 goal 补", () => {
    const legacy = {
      ...block,
      summary: {
        goal: summary.goal,
        constraints: summary.constraints,
        decisions: summary.decisions,
        progress: summary.progress,
        open_items: summary.open_items,
        files: summary.files,
        facts: summary.facts,
      },
    }
    expect(parseState({ v: 1, blocks: [legacy], attempts: 0 }).blocks[0]?.summary.title).toBe("implement compression")
  })
})

describe("渲染", () => {
  it("块头、章节与多块顺序", () => {
    expect(blockMarker("b1")).toBe("[Compressed conversation section #b1]")
    const text = renderAll([block, { ...block, id: "b2" }])
    expect(text.startsWith(blockMarker("b1"))).toBe(true)
    expect(text).toContain("## Goal")
    expect(text).toContain("implement compression")
    expect(text.indexOf(blockMarker("b1"))).toBeLessThan(text.indexOf(blockMarker("b2")))
  })

  it("块头可以带标题，标记仍可被 includes 命中", () => {
    const titled = renderBlock({ ...block, summary: { ...summary, title: "压缩内核" } })
    expect(titled.startsWith(`${blockMarker("b1")} 压缩内核`)).toBe(true)
    expect(titled).toContain(blockMarker("b1"))
  })
})

describe("校验", () => {
  it("通过合法摘要", () => {
    expect(validateSummary(summary, 10_000).ok).toBe(true)
  })

  it("拒绝空 goal、过短、比原文大", () => {
    expect(validateSummary({ ...summary, goal: " " }, 10_000).fields).toContain("goal")
    expect(validateSummary({ ...summary, facts: [] }, 300).ok).toBe(false)
    expect(validateSummary(summary, 100).ok).toBe(false)
  })

  it("拒绝空标题与超长标题", () => {
    expect(validateSummary({ ...summary, title: " " }, 10_000).fields).toContain("title")
    expect(validateSummary({ ...summary, title: "x".repeat(81) }, 10_000).fields).toContain("title")
  })
})

describe("服务端设置", () => {
  it("解析合法值，拒绝越界", () => {
    expect(parseServerSettings({ contextLimit: "auto", triggerPercent: 80 })).toEqual({
      contextLimit: "auto",
      triggerPercent: 80,
    })
    expect(parseServerSettings({ contextLimit: 200_000, triggerPercent: 95 })).toBeDefined()
    expect(parseServerSettings({ contextLimit: "auto", triggerPercent: 59 })).toBeUndefined()
    expect(parseServerSettings({ contextLimit: "auto", triggerPercent: 96 })).toBeUndefined()
    expect(parseServerSettings({ contextLimit: "nope", triggerPercent: 80 })).toBeUndefined()
  })
})

describe("transcript", () => {
  it("截断工具输出并保留 user 文本", () => {
    const messages: MessageLike[] = [
      message("user", "hello"),
      { role: "assistant", content: [{ type: "tool-result", name: "shell", result: "x".repeat(5000) }] },
    ]
    const text = buildTranscript(messages)
    expect(text).toContain("[User]")
    expect(text).toContain("truncated")
    expect(text.length).toBeLessThan(5000)
  })
})

describe("侧调用摘要", () => {
  it("解析带围栏的 JSON", async () => {
    const result = await summarize({
      transcript: "x",
      sourceChars: 10_000,
      generate: { text: () => Promise.resolve({ text: "```json\n" + JSON.stringify(summary) + "\n```" }) },
    })
    expect(result?.goal).toBe(summary.goal)
  })

  it("第一次坏 JSON 时重试一次", async () => {
    let calls = 0
    const result = await summarize({
      transcript: "x",
      sourceChars: 10_000,
      generate: {
        text: () => {
          calls += 1
          return Promise.resolve({ text: calls === 1 ? "not json" : JSON.stringify(summary) })
        },
      },
    })
    expect(calls).toBe(2)
    expect(result?.goal).toBe(summary.goal)
  })

  it("两次都失败返回 undefined", async () => {
    const result = await summarize({
      transcript: "x",
      sourceChars: 10_000,
      generate: { text: () => Promise.resolve({ text: "nope" }) },
    })
    expect(result).toBeUndefined()
  })
})
