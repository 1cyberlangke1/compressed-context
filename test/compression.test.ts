import { describe, expect, it } from "vitest"
import type { Schema } from "effect"
import type { Plugin } from "@opencode/plugin"

import { maybeAutoCompress } from "../src/compression/auto.ts"
import { distillOnce, mergeCandidates, planT1Phase } from "../src/compression/distill.ts"
import { handleCompactionEvent } from "../src/compression/events.ts"
import { parseServerSettings, SETTINGS_KEY } from "../src/compression/settings.ts"
import { activeBlocks, blockMarker, renderAll, renderBlock } from "../src/compression/render.ts"
import type { SummaryFields } from "../src/compression/schema.ts"
import { eligibleMessages, isCheckpoint, olderMessages, textChars, type MessageLike } from "../src/compression/select.ts"
import { commitPending, dropPending, loadState, parseState, saveState, stateKey, withPending, withPhase, type Block, type StorageLike } from "../src/compression/state.ts"
import {
  buildMergeInstruction,
  buildT1Instruction,
  sessionGenerator,
  summarize,
  summarizeInstruction,
  summarizeWithChoice,
} from "../src/compression/summarize.ts"
import { registerCompressTool } from "../src/compression/tool.ts"
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

/** 输入：storage / 摘要回复 / compact 回调；输出：够自动压缩和 distill 用的假 ctx。 */
function fakeCtx(
  storage: StorageLike,
  text: (input: { prompt: string }) => Promise<{ text: string }>,
  compact: () => Promise<void>,
): Plugin.Context {
  return {
    storage,
    model: { list: () => Promise.resolve({ data: [] }) },
    generate: { text },
    session: {
      compact,
      generate: (input: { sessionID: string; prompt: string }) => text({ prompt: input.prompt }),
    },
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

  it("compaction 的 older 消息排除 checkpoint 后全部可压", () => {
    const checkpoint = message("user", "<conversation-checkpoint>old</conversation-checkpoint>", "m0")
    const older = [
      checkpoint,
      message("user", "first", "m1"),
      message("assistant", "reply", "m2"),
    ]
    expect(olderMessages(older).map((item) => item.id)).toEqual(["m1", "m2"])
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

  it("phase 在提交时保留、失败时清掉", () => {
    const pending = withPending({ v: 1, blocks: [], attempts: 0, phase: "t2" }, block)
    expect(commitPending(pending).phase).toBe("t2")
    expect(dropPending(pending, "boom").phase).toBeUndefined()
    expect(withPhase(pending, undefined).phase).toBeUndefined()
    expect(parseState({ v: 1, blocks: [], attempts: 0, phase: "t3" }).phase).toBe("t3")
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

  it("session 生成只追加指令，不重发 transcript", async () => {
    const calls: { sessionID: string; prompt: string }[] = []
    const generate = sessionGenerator(
      {
        generate: (input) => {
          calls.push(input)
          return Promise.resolve({ text: JSON.stringify(summary) })
        },
      },
      "ses_test",
    )
    const prompt = buildT1Instruction()
    const result = await summarizeInstruction({ prompt, sourceChars: 10_000, generate })
    expect(result?.goal).toBe(summary.goal)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.sessionID).toBe("ses_test")
    expect(calls[0]?.prompt).toBe(prompt)
    expect(calls[0]?.prompt).not.toContain("Sources:")
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
    expect(state.pending).toBeUndefined()
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

  it("已有块时只入队 compaction，不改 pending", async () => {
    const storage = memoryStorage({
      [SETTINGS_KEY]: { contextLimit: 1_000, triggerPercent: 60 },
      [stateKey("ses_test")]: { v: 1, blocks: [block], attempts: 0 },
    })
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
    expect(state.blocks).toHaveLength(1)
    expect(state.pending).toBeUndefined()
    expect(state.attempts).toBe(0)
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

describe("T1 phase 决策", () => {
  it("预算内或没有合法候选不排 T2", () => {
    expect(planT1Phase("short", [tierBlock("b1", 1, 1), tierBlock("b2", 1, 2)], 5_000)).toBeUndefined()
    expect(planT1Phase("x".repeat(30_000), [tierBlock("b1", 1, 1)], 5_000)).toBeUndefined()
  })

  it("超预算且有合法候选排 T2", () => {
    expect(planT1Phase("x".repeat(30_000), [tierBlock("b1", 1, 1), tierBlock("b2", 1, 2)], 5_000)).toBe(
      "t2",
    )
  })
})

describe("会话隔离", () => {
  it("不同 session 的 blocks 和 phase 不串", async () => {
    const storage = memoryStorage()
    await saveState(storage, "ses_a", {
      v: 1,
      blocks: [tierBlock("b1", 1, 1)],
      attempts: 0,
      phase: "t2",
    })
    await saveState(storage, "ses_b", {
      v: 1,
      blocks: [tierBlock("b1", 2, 1)],
      attempts: 0,
    })
    const a = await loadState(storage, "ses_a")
    const b = await loadState(storage, "ses_b")
    expect(a.blocks[0]?.tier).toBe(1)
    expect(a.phase).toBe("t2")
    expect(b.blocks[0]?.tier).toBe(2)
    expect(b.phase).toBeUndefined()
  })
})

describe("compaction 事件", () => {
  /** 输入：storage + 最新 summary；输出：带 session.context 的假 ctx。 */
  const eventCtx = (storage: StorageLike, latestSummary: string): Plugin.Context =>
    ({
      storage,
      session: {
        context: () =>
          Promise.resolve([{ type: "compaction", status: "completed", summary: latestSummary }]),
      },
    }) as unknown as Plugin.Context

  it("最新 checkpoint 包含 pending 才转正", async () => {
    const storage = memoryStorage({
      [stateKey("ses_event")]: withPending({ v: 1, blocks: [], attempts: 0 }, block),
    })
    await handleCompactionEvent(eventCtx(storage, blockMarker("b1")), "ended", "ses_event")
    const state = await loadState(storage, "ses_event")
    expect(state.blocks).toHaveLength(1)
    expect(state.pending).toBeUndefined()
  })

  it("晚到事件不提交不属于它的 pending", async () => {
    const storage = memoryStorage({
      [stateKey("ses_event")]: withPending({ v: 1, blocks: [], attempts: 0 }, block),
    })
    await handleCompactionEvent(eventCtx(storage, "another checkpoint"), "ended", "ses_event")
    const state = await loadState(storage, "ses_event")
    expect(state.blocks).toHaveLength(0)
    expect(state.pending?.id).toBe("b1")
  })

  it("失败事件丢弃 pending 和 phase", async () => {
    const storage = memoryStorage({
      [stateKey("ses_event")]: withPhase(
        withPending({ v: 1, blocks: [], attempts: 0 }, block),
        "t2",
      ),
    })
    await handleCompactionEvent(eventCtx(storage, ""), "failed", "ses_event")
    const state = await loadState(storage, "ses_event")
    expect(state.pending).toBeUndefined()
    expect(state.phase).toBeUndefined()
  })
})

describe("缓存尾追加", () => {
  it("T2 指令只追加在会话前缀尾部", () => {
    const prefix = "system\n[checkpoint b1 b2]\nrecent"
    const instruction = buildMergeInstruction([
      { index: 1, description: "b1+b2 → T2", sourceChars: 1_000, tier: 2 },
    ])
    const request = `${prefix}\n${instruction}`
    expect(request.startsWith(prefix)).toBe(true)
    expect(instruction).not.toContain("Sources:")
    expect(instruction).toContain("Candidates")
    expect(instruction).toContain("checkpoint")
  })
})

describe("compress 工具只做 T1", () => {
  interface ToolDefinition {
    execute: (
      input: SummaryFields,
      ctx: { sessionID: string },
    ) => Promise<{ content: string; output?: { block: string; status: string } }>
  }

  /** 输入：storage；输出：捕获工具定义。 */
  const toolCtx = (storage: StorageLike): { ctx: Plugin.Context; tool: () => ToolDefinition } => {
    let definition: ToolDefinition | undefined
    const ctx = {
      storage,
      tool: {
        transform: (fn: (tools: { add: (tool: ToolDefinition) => void }) => void) => {
          fn({ add: (tool) => { definition = tool } })
          return Promise.resolve({ dispose: () => Promise.resolve() })
        },
      },
      session: {
        compact: () => Promise.resolve(),
      },
    } as unknown as Plugin.Context
    return {
      ctx,
      tool: () => {
        if (definition === undefined) throw new Error("tool not registered")
        return definition
      },
    }
  }

  const toolMessages = (): MessageLike[] => [
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

  it("成功时只挂 T1 pending", async () => {
    const storage = memoryStorage()
    const { ctx, tool } = toolCtx(storage)
    await registerCompressTool(ctx, new Map([["ses_test", toolMessages()]]))
    const result = await tool().execute(summary, { sessionID: "ses_test" })
    const state = await loadState(storage, "ses_test")
    expect(result.output?.block).toBe("b1")
    expect(state.pending?.tier).toBe(1)
    expect(state.pending?.sourceBlockIds).toBeUndefined()
    expect(state.phase).toBeUndefined()
  })

  it("pending 或 phase 非空时拒绝，不改状态", async () => {
    const pendingStorage = memoryStorage({
      [stateKey("ses_test")]: withPending({ v: 1, blocks: [], attempts: 0 }, block),
    })
    const pending = toolCtx(pendingStorage)
    await registerCompressTool(pending.ctx, new Map([["ses_test", toolMessages()]]))
    const pendingResult = await pending.tool().execute(summary, { sessionID: "ses_test" })
    expect(pendingResult.content).toContain("compression already in progress")

    const phaseStorage = memoryStorage({
      [stateKey("ses_test")]: withPhase({ v: 1, blocks: [], attempts: 0 }, "t2"),
    })
    const phase = toolCtx(phaseStorage)
    await registerCompressTool(phase.ctx, new Map([["ses_test", toolMessages()]]))
    const phaseResult = await phase.tool().execute(summary, { sessionID: "ses_test" })
    expect(phaseResult.content).toContain("compression already in progress")
  })
})
describe("摘要单层合并", () => {
  it("预算内不合并", async () => {
    let calls = 0
    const ctx = fakeCtx(
      memoryStorage(),
      () => {
        calls += 1
        return Promise.resolve({ text: JSON.stringify({ candidate: 1, ...summary }) })
      },
      () => Promise.resolve(),
    )
    const result = await distillOnce({
      ctx,
      sessionID: "ses_test",
      state: { v: 1, blocks: [block], attempts: 0 },
      pending: { ...block, id: "b2", order: 2 },
      budgetTokens: 50_000,
      phase: "t2",
    })
    expect(result.merged).toBe(false)
    expect(result.pending?.id).toBe("b2")
    expect(calls).toBe(0)
  })

  it("超预算时只合并一对", async () => {
    let calls = 0
    const ctx = fakeCtx(
      memoryStorage(),
      () => {
        calls += 1
        return Promise.resolve({ text: JSON.stringify({ candidate: 1, ...summary }) })
      },
      () => Promise.resolve(),
    )
    const result = await distillOnce({
      ctx,
      sessionID: "ses_test",
      state: { v: 1, blocks: [longBlock("b1", 1, 1)], attempts: 0 },
      pending: longBlock("b2", 1, 2),
      budgetTokens: 5_000,
      phase: "t2",
    })
    expect(calls).toBe(1)
    expect(result.merged).toBe(true)
    expect(result.pending?.tier).toBe(2)
    expect(result.pending?.sourceBlockIds).toEqual(["b1", "b2"])
    expect(result.pending?.order).toBe(1)
    expect(activeBlocks(result.blocks, result.pending).map((item) => item.id)).toEqual([result.pending?.id])
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
    const result = await distillOnce({
      ctx,
      sessionID: "ses_test",
      state: {
        v: 1,
        blocks: [longBlock("b1", 2, 1), tierBlock("b2", 2, 2), tierBlock("b3", 1, 3)],
        attempts: 0,
      },
      pending: tierBlock("b4", 1, 4),
      budgetTokens: 5_000,
      phase: "t2",
    })
    expect(calls).toBe(1)
    expect(result.merged).toBe(true)
    expect(result.pending?.sourceBlockIds).toEqual(["b1", "b2"])
    expect(result.pending?.tier).toBe(3)
    expect(result.nextPhase).toBeUndefined()
    expect(activeBlocks(result.blocks, result.pending).map((item) => item.id)).toEqual([
      result.pending?.id,
      "b3",
      "b4",
    ])
  })

  it("T2 后还超预算时返回 nextPhase=t3", async () => {
    const ctx = fakeCtx(
      memoryStorage(),
      () => Promise.resolve({ text: JSON.stringify({ candidate: 1, ...summary }) }),
      () => Promise.resolve(),
    )
    const result = await distillOnce({
      ctx,
      sessionID: "ses_test",
      state: {
        v: 1,
        blocks: [longBlock("b1", 2, 1), tierBlock("b2", 2, 2), longBlock("b3", 1, 3)],
        attempts: 0,
      },
      pending: tierBlock("b4", 1, 4),
      budgetTokens: 5_000,
      phase: "t2",
    })
    expect(result.merged).toBe(true)
    expect(result.nextPhase).toBe("t3")
  })

  it("合并摘要失败时保留源块", async () => {
    const ctx = fakeCtx(
      memoryStorage(),
      () => Promise.resolve({ text: "not json" }),
      () => Promise.resolve(),
    )
    const result = await distillOnce({
      ctx,
      sessionID: "ses_test",
      state: { v: 1, blocks: [longBlock("b1", 1, 1)], attempts: 0 },
      pending: longBlock("b2", 1, 2),
      budgetTokens: 5_000,
      phase: "t2",
    })
    expect(result.merged).toBe(false)
    expect(result.error).toBe("distill summary failed")
    expect(result.blocks).toHaveLength(1)
    expect(result.pending?.id).toBe("b2")
  })
})
