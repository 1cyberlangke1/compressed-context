import { describe, expect, it } from "vitest"
import type { Schema } from "effect"
import type { Plugin } from "@opencode/plugin"

import { maybeAutoCompress } from "../src/compression/auto.ts"
import { distillChain, mergeCandidates } from "../src/compression/distill.ts"
import { parseServerSettings, SETTINGS_KEY } from "../src/compression/settings.ts"
import { activeBlocks, blockMarker, renderAll, renderBlock } from "../src/compression/render.ts"
import type { SummaryFields } from "../src/compression/schema.ts"
import { eligibleMessages, isCheckpoint, textChars, type MessageLike } from "../src/compression/select.ts"
import { commitPending, dropPending, loadState, parseState, stateKey, withPending, type Block, type StorageLike } from "../src/compression/state.ts"
import { summarize, summarizeWithChoice } from "../src/compression/summarize.ts"
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
  order: 1,
}

const message = (role: string, text: string, id?: string): MessageLike => ({
  id,
  role,
  content: [{ type: "text", text }],
})

/** 输入：id/tier/order；输出：测试用块。 */
const tierBlock = (id: string, tier: 1 | 2 | 3, order: number): Block => ({
  ...block,
  id,
  tier,
  order,
})

/** 输入：id/tier/order；输出：摘要大到足以超过预算的块。 */
const longBlock = (id: string, tier: 1 | 2 | 3, order: number): Block => ({
  ...tierBlock(id, tier, order),
  summary: { ...summary, facts: ["x".repeat(24_000)] },
})

/** 输入：初始键值；输出：内存版 StorageLike。 */
function memoryStorage(initial: Record<string, unknown> = {}): StorageLike {
  const values = new Map<string, Schema.Json>(Object.entries(initial) as [string, Schema.Json][])
  return {
    get: (key) => Promise.resolve(values.get(key)),
    set: (key, value) => {
      values.set(key, value)
      return Promise.resolve()
    },
    remove: (key) => {
      values.delete(key)
      return Promise.resolve()
    },
  }
}

/** 输入：storage / 摘要回复 / compact 回调；输出：够 maybeAutoCompress 用的假 ctx。 */
function fakeCtx(
  storage: StorageLike,
  text: (input: { prompt: string }) => Promise<{ text: string }>,
  compact: () => Promise<void>,
): Plugin.Context {
  return {
    storage,
    model: { list: () => Promise.resolve({ data: [] }) },
    generate: { text },
    session: { compact },
  } as unknown as Plugin.Context
}

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
      summaryBudgetTokens: 50_000,
    })
    expect(parseServerSettings({ contextLimit: 200_000, triggerPercent: 95, summaryBudgetTokens: 20_000 })).toEqual({
      contextLimit: 200_000,
      triggerPercent: 95,
      summaryBudgetTokens: 20_000,
    })
    expect(parseServerSettings({ contextLimit: "auto", triggerPercent: 59 })).toBeUndefined()
    expect(parseServerSettings({ contextLimit: "auto", triggerPercent: 96 })).toBeUndefined()
    expect(parseServerSettings({ contextLimit: "auto", triggerPercent: 80, summaryBudgetTokens: 4_999 })).toBeUndefined()
    expect(parseServerSettings({ contextLimit: "auto", triggerPercent: 80, summaryBudgetTokens: 1_000_001 })).toBeUndefined()
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

  it("多候选时一次返回 candidate + 摘要", async () => {
    const result = await summarizeWithChoice({
      context: "b1 + b2",
      task: "continue the task",
      candidates: [{ index: 1, description: "b1+b2 → T2", sourceChars: 10_000, tier: 2 }],
      generate: {
        text: () => Promise.resolve({ text: JSON.stringify({ candidate: 1, ...summary }) }),
      },
    })
    expect(result?.candidate.index).toBe(1)
    expect(result?.summary.goal).toBe(summary.goal)
  })
})

describe("自动压缩", () => {
  /** 输入：无；输出：纯文本少、工具输出多的消息。 */
  const autoMessages = (): MessageLike[] => [
    message("user", "hi", "m1"),
    {
      id: "m2",
      role: "assistant",
      content: [
        { type: "text", text: "short" },
        ...Array.from({ length: 3 }, () => ({
          type: "tool-result",
          name: "shell",
          result: "x".repeat(6_000),
        })),
      ],
    },
    message("user", "continue", "m3"),
  ]

  it("纯文本不够但工具输出足够时仍然触发", async () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: { contextLimit: 1_000, triggerPercent: 60 } })
    let compacts = 0
    const ctx = fakeCtx(
      storage,
      () => Promise.resolve({ text: JSON.stringify(summary) }),
      () => {
        compacts += 1
        return Promise.resolve()
      },
    )
    await maybeAutoCompress({
      ctx,
      sessionID: "ses_test",
      messages: autoMessages(),
      system: [],
      tools: {},
      model: { providerID: "test", id: "test" },
    })
    const state = await loadState(storage, "ses_test")
    expect(compacts).toBe(1)
    expect(state.pending?.summary.goal).toBe(summary.goal)
  })

  it("只有 checkpoint 的 recent 撑大总量时不触发", async () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: { contextLimit: 1_000, triggerPercent: 60 } })
    let compacts = 0
    const ctx = fakeCtx(
      storage,
      () => Promise.resolve({ text: JSON.stringify(summary) }),
      () => {
        compacts += 1
        return Promise.resolve()
      },
    )
    const checkpoint = message(
      "user",
      `<conversation-checkpoint><summary>old</summary><recent-context>${"x".repeat(20_000)}</recent-context></conversation-checkpoint>`,
      "m0",
    )
    await maybeAutoCompress({
      ctx,
      sessionID: "ses_test",
      messages: [
        checkpoint,
        message("user", "hi", "m1"),
        message("assistant", "short", "m2"),
        message("user", "continue", "m3"),
      ],
      system: [],
      tools: {},
      model: { providerID: "test", id: "test" },
    })
    const state = await loadState(storage, "ses_test")
    expect(compacts).toBe(0)
    expect(state.pending).toBeUndefined()
  })

  it("摘要失败时保留已有块并记一次失败", async () => {
    const storage = memoryStorage({
      [SETTINGS_KEY]: { contextLimit: 1_000, triggerPercent: 60 },
      [stateKey("ses_test")]: { v: 1, blocks: [block], attempts: 0 },
    })
    let compacts = 0
    const ctx = fakeCtx(
      storage,
      () => Promise.resolve({ text: "not json" }),
      () => {
        compacts += 1
        return Promise.resolve()
      },
    )
    await maybeAutoCompress({
      ctx,
      sessionID: "ses_test",
      messages: autoMessages(),
      system: [],
      tools: {},
      model: { providerID: "test", id: "test" },
    })
    const state = await loadState(storage, "ses_test")
    expect(compacts).toBe(0)
    expect(state.blocks).toHaveLength(1)
    expect(state.attempts).toBe(1)
    expect(state.lastError).toBe("auto summary failed")
  })
})

describe("合并候选", () => {
  it("T1 T1 只有一种合法合并", () => {
    const candidates = mergeCandidates([tierBlock("b1", 1, 1), tierBlock("b2", 1, 2)])
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.tier).toBe(2)
    expect(candidates[0]?.left.id).toBe("b1")
  })

  it("T2 T2 T1 T1 只有前面 T2 对和后面 T1 对", () => {
    const candidates = mergeCandidates([
      tierBlock("b1", 2, 1),
      tierBlock("b2", 2, 2),
      tierBlock("b3", 1, 3),
      tierBlock("b4", 1, 4),
    ])
    expect(candidates.map((candidate) => `${candidate.left.id}+${candidate.right.id}:T${candidate.tier.toString()}`)).toEqual([
      "b1+b2:T3",
      "b3+b4:T2",
    ])
  })

  it("T3 T2 T1 可以把前两块或后两块合到 T3", () => {
    const candidates = mergeCandidates([
      tierBlock("b1", 3, 1),
      tierBlock("b2", 2, 2),
      tierBlock("b3", 1, 3),
    ])
    expect(candidates.map((candidate) => `${candidate.left.id}+${candidate.right.id}:T${candidate.tier.toString()}`)).toEqual([
      "b1+b2:T3",
      "b2+b3:T3",
    ])
  })

  it("T1 T1 T1 只能合最前面两块", () => {
    const candidates = mergeCandidates([
      tierBlock("b1", 1, 1),
      tierBlock("b2", 1, 2),
      tierBlock("b3", 1, 3),
    ])
    expect(candidates.map((candidate) => candidate.left.id)).toEqual(["b1"])
  })
})

describe("active 链", () => {
  it("被 sourceBlockIds 引用的块不再渲染", () => {
    const left = tierBlock("b1", 1, 1)
    const right = tierBlock("b2", 1, 2)
    const merged: Block = {
      ...tierBlock("b3", 2, 1),
      sourceBlockIds: ["b1", "b2"],
    }
    expect(activeBlocks([left, right, merged]).map((item) => item.id)).toEqual(["b3"])
    expect(renderAll([left, right, merged])).not.toContain(blockMarker("b1"))
  })

  it("合并块占第一个源块的位置", () => {
    const first = tierBlock("b1", 2, 1)
    const second = tierBlock("b2", 2, 2)
    const younger = tierBlock("b3", 1, 3)
    const merged: Block = {
      ...tierBlock("b4", 3, 1),
      sourceBlockIds: ["b1", "b2"],
    }
    expect(activeBlocks([first, second, younger, merged]).map((item) => item.id)).toEqual(["b4", "b3"])
  })
})

describe("摘要阻塞合并", () => {
  it("预算内不合并", async () => {
    let calls = 0
    const ctx = fakeCtx(
      memoryStorage(),
      () => {
        calls += 1
        return Promise.resolve({ text: JSON.stringify(summary) })
      },
      () => Promise.resolve(),
    )
    const result = await distillChain({
      ctx,
      model: undefined,
      state: { v: 1, blocks: [block], attempts: 0 },
      pending: { ...block, id: "b2", order: 2 },
      budgetTokens: 50_000,
    })
    expect(result.merges).toBe(0)
    expect(result.pending.id).toBe("b2")
    expect(calls).toBe(0)
  })

  it("超预算时同步合并唯一候选", async () => {
    let calls = 0
    const ctx = fakeCtx(
      memoryStorage(),
      () => {
        calls += 1
        return Promise.resolve({ text: JSON.stringify(summary) })
      },
      () => Promise.resolve(),
    )
    const result = await distillChain({
      ctx,
      model: { providerID: "test", id: "test" },
      state: { v: 1, blocks: [longBlock("b1", 1, 1)], attempts: 0 },
      pending: longBlock("b2", 1, 2),
      budgetTokens: 5_000,
    })
    expect(calls).toBe(1)
    expect(result.merges).toBe(1)
    expect(result.pending.tier).toBe(2)
    expect(result.pending.sourceBlockIds).toEqual(["b1", "b2"])
    expect(result.pending.order).toBe(1)
    expect(activeBlocks(result.blocks, result.pending).map((item) => item.id)).toEqual([result.pending.id])
  })

  it("多候选时模型一次返回 candidate 和摘要", async () => {
    let calls = 0
    const ctx = fakeCtx(
      memoryStorage(),
      () => {
        calls += 1
        return Promise.resolve({ text: JSON.stringify({ candidate: 1, ...summary }) })
      },
      () => Promise.resolve(),
    )
    const result = await distillChain({
      ctx,
      model: { providerID: "test", id: "test" },
      state: {
        v: 1,
        blocks: [
          longBlock("b1", 2, 1),
          tierBlock("b2", 2, 2),
          tierBlock("b3", 1, 3),
        ],
        attempts: 0,
      },
      pending: tierBlock("b4", 1, 4),
      budgetTokens: 5_000,
    })
    expect(calls).toBe(1)
    expect(result.merges).toBe(1)
    expect(result.pending.sourceBlockIds).toEqual(["b1", "b2"])
    expect(result.pending.tier).toBe(3)
    expect(activeBlocks(result.blocks, result.pending).map((item) => item.id)).toEqual([
      result.pending.id,
      "b3",
      "b4",
    ])
  })

  it("合并摘要失败时保留源块", async () => {
    const ctx = fakeCtx(
      memoryStorage(),
      () => Promise.resolve({ text: "not json" }),
      () => Promise.resolve(),
    )
    const result = await distillChain({
      ctx,
      model: undefined,
      state: { v: 1, blocks: [longBlock("b1", 1, 1)], attempts: 0 },
      pending: longBlock("b2", 1, 2),
      budgetTokens: 5_000,
    })
    expect(result.merges).toBe(0)
    expect(result.error).toBe("distill summary failed")
    expect(result.blocks).toHaveLength(1)
    expect(result.pending.id).toBe("b2")
  })
})
