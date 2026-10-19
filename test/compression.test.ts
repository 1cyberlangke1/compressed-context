import { describe, expect, it } from "vitest"
import type { Schema } from "effect"
import type { Plugin } from "@opencode/plugin"

import { markCompactionInFlight, maybeAutoCompress } from "../src/compression/auto.ts"
import { distillOnce, mergeCandidates, planT1Phase } from "../src/compression/distill.ts"
import { handleCompactionEvent, isPermanentFailure, retryState } from "../src/compression/events.ts"
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
import { minSummaryChars, validateSummary } from "../src/compression/validate.ts"

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
    expect(validateSummary({ ...summary, facts: [] }, 150).ok).toBe(false)
    expect(validateSummary(summary, 100).ok).toBe(false)
  })

  it("拒绝空标题与超长标题", () => {
    expect(validateSummary({ ...summary, title: " " }, 10_000).fields).toContain("title")
    expect(validateSummary({ ...summary, title: "x".repeat(81) }, 10_000).fields).toContain("title")
  })

  it("maxChars 可配置", () => {
    expect(validateSummary(summary, 10_000, undefined, 100).message).toContain("too long")
    expect(validateSummary(summary, 10_000, undefined, 100_000).ok).toBe(true)
  })

  it("分层下限：T1 200，T2 80，T3 40", () => {
    const tiny = {
      ...summary,
      title: "t",
      goal: "x".repeat(80),
      constraints: [],
      decisions: [],
      progress: { completed: [], active: [], blocked: [] },
      open_items: [],
      files: [],
      facts: [],
    }
    expect(minSummaryChars(1)).toBe(200)
    expect(minSummaryChars(2)).toBe(80)
    expect(minSummaryChars(3)).toBe(40)
    expect(validateSummary(tiny, 10_000, minSummaryChars(2)).ok).toBe(true)
    expect(validateSummary(tiny, 10_000, minSummaryChars(1)).ok).toBe(false)
    expect(validateSummary(tiny, 10_000, minSummaryChars(3)).ok).toBe(true)
  })
})

describe("服务端设置", () => {
  it("解析合法值，拒绝越界", () => {
    expect(parseServerSettings({ contextLimit: "auto", triggerPercent: 80 })).toEqual({
      contextLimit: "auto",
      triggerPercent: 80,
      summaryBudgetTokens: 50_000,
      summaryBlockChars: 20_000,
      summaryTotalChars: 100_000,
      summaryLanguage: "auto",
    })
    expect(
      parseServerSettings({
        contextLimit: 200_000,
        triggerPercent: 95,
        summaryBudgetTokens: 20_000,
        summaryBlockChars: 30_000,
        summaryTotalChars: 190_000,
        summaryLanguage: "zh",
      }),
    ).toEqual({
      contextLimit: 200_000,
      triggerPercent: 95,
      summaryBudgetTokens: 20_000,
      summaryBlockChars: 30_000,
      summaryTotalChars: 190_000,
      summaryLanguage: "zh",
    })
    expect(parseServerSettings({ contextLimit: "auto", triggerPercent: 59 })).toBeUndefined()
    expect(parseServerSettings({ contextLimit: "auto", triggerPercent: 96 })).toBeUndefined()
    expect(parseServerSettings({ contextLimit: "auto", triggerPercent: 80, summaryBudgetTokens: 4_999 })).toBeUndefined()
    expect(parseServerSettings({ contextLimit: "auto", triggerPercent: 80, summaryBudgetTokens: 1_000_001 })).toBeUndefined()
    expect(parseServerSettings({ contextLimit: "nope", triggerPercent: 80 })).toBeUndefined()
  })

  it("拒绝任意非法摘要长度和语言", () => {
    const base = { contextLimit: "auto", triggerPercent: 80 }
    for (const bad of [499, 100_001, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(parseServerSettings({ ...base, summaryBlockChars: bad })).toBeUndefined()
    }
    for (const bad of [4_999, 1_000_001, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(parseServerSettings({ ...base, summaryTotalChars: bad })).toBeUndefined()
    }
    expect(
      parseServerSettings({ ...base, summaryBlockChars: 30_000, summaryTotalChars: 20_000 }),
    ).toBeUndefined()
    expect(parseServerSettings({ ...base, summaryLanguage: "fr" })).toBeUndefined()
  })

  it("数字窗口下摘要上限不得超过窗口减预留", () => {
    const base = { triggerPercent: 80, summaryLanguage: "auto" }
    const limit = 30_000
    const ceiling = limit - 10_000
    expect(
      parseServerSettings({ ...base, contextLimit: limit, summaryBlockChars: ceiling, summaryTotalChars: ceiling }),
    ).toBeDefined()
    expect(
      parseServerSettings({ ...base, contextLimit: limit, summaryBlockChars: 500, summaryTotalChars: ceiling + 1 }),
    ).toBeUndefined()
    expect(
      parseServerSettings({ ...base, contextLimit: limit, summaryBlockChars: ceiling + 1, summaryTotalChars: ceiling + 1 }),
    ).toBeUndefined()
    // 窗口小到装不下最小摘要时不校验（运行时兜底），设置照常接受。
    expect(parseServerSettings({ ...base, contextLimit: 10_000, summaryBlockChars: 500 })).toBeDefined()
    // auto 窗口保存时不校验，运行时钳制。
    expect(
      parseServerSettings({ ...base, contextLimit: "auto", summaryBlockChars: 100_000, summaryTotalChars: 200_000 }),
    ).toBeDefined()
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

  it("两次都失败时抛出解析原因", async () => {
    await expect(
      summarize({
        transcript: "x",
        sourceChars: 10_000,
        generate: { text: () => Promise.resolve({ text: "nope" }) },
      }),
    ).rejects.toThrow("not valid JSON")
  })

  it("generate 抛错时保留真实原因并抛出", async () => {
    let reason = ""
    await expect(
      summarizeInstruction({
        prompt: "x",
        sourceChars: 10_000,
        generate: { text: () => Promise.reject(new Error("network down")) },
        onFailure: (value) => {
          reason = value
        },
      }),
    ).rejects.toThrow("network down")
    expect(reason).toContain("network down")
  })

  it("JSON 非法时保留解析原因并抛出", async () => {
    let reason = ""
    await expect(
      summarizeInstruction({
        prompt: "x",
        sourceChars: 10_000,
        generate: { text: () => Promise.resolve({ text: "nope" }) },
        onFailure: (value) => {
          reason = value
        },
      }),
    ).rejects.toThrow("not valid JSON")
    expect(reason).toContain("not valid JSON")
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

  it("多候选返回非法 candidate 时抛出原因", async () => {
    await expect(
      summarizeWithChoice({
        context: "b1 + b2",
        task: "continue",
        candidates: [{ index: 1, description: "b1+b2", sourceChars: 10_000, tier: 2 }],
        generate: { text: () => Promise.resolve({ text: JSON.stringify({ candidate: 99, ...summary }) }) },
      }),
    ).rejects.toThrow("valid candidate")
  })

  it("解析前后带说明的 JSON", async () => {
    const result = await summarize({
      transcript: "x",
      sourceChars: 10_000,
      generate: {
        text: () =>
          Promise.resolve({
            text: `Here is the checkpoint:\n${JSON.stringify(summary)}\nDone.`,
          }),
      },
    })
    expect(result?.goal).toBe(summary.goal)
  })

  it("补齐缺失字段和字符串数组", async () => {
    const result = await summarize({
      transcript: "x",
      sourceChars: 10_000,
      generate: {
        text: () =>
          Promise.resolve({
            text: JSON.stringify({
              title: "partial",
              goal: "keep going",
              facts: "x".repeat(300),
            }),
          }),
      },
    })
    expect(result?.facts).toHaveLength(1)
    expect(result?.progress).toEqual({ completed: [], active: [], blocked: [] })
    expect(result?.constraints).toEqual([])
  })

  it("解析双编码 JSON", async () => {
    const result = await summarize({
      transcript: "x",
      sourceChars: 10_000,
      generate: { text: () => Promise.resolve({ text: JSON.stringify(JSON.stringify(summary)) }) },
    })
    expect(result?.goal).toBe(summary.goal)
  })

  it("修复截断 JSON", async () => {
    const large = { ...summary, goal: "g".repeat(300) }
    const result = await summarize({
      transcript: "x",
      sourceChars: 10_000,
      generate: { text: () => Promise.resolve({ text: JSON.stringify(large).slice(0, -1) }) },
    })
    expect(result?.goal).toHaveLength(300)
  })

  it("超长 title 自动截断", async () => {
    const result = await summarize({
      transcript: "x",
      sourceChars: 10_000,
      generate: {
        text: () => Promise.resolve({ text: JSON.stringify({ ...summary, title: "x".repeat(100) }) }),
      },
    })
    expect(result?.title).toHaveLength(80)
  })

  it("空 goal 抛出精确原因", async () => {
    await expect(
      summarize({
        transcript: "x",
        sourceChars: 10_000,
        generate: { text: () => Promise.resolve({ text: JSON.stringify({ ...summary, goal: "" }) }) },
      }),
    ).rejects.toThrow("empty field: goal")
  })

  it("摘要超过 maxChars 时抛出精确原因", async () => {
    await expect(
      summarize({
        transcript: "x",
        sourceChars: 10_000,
        maxChars: 100,
        generate: { text: () => Promise.resolve({ text: JSON.stringify(summary) }) },
      }),
    ).rejects.toThrow("summary too long")
  })

  it("摘要不小于原文时抛出精确原因", async () => {
    await expect(
      summarize({
        transcript: "x",
        sourceChars: 100,
        generate: { text: () => Promise.resolve({ text: JSON.stringify(summary) }) },
      }),
    ).rejects.toThrow("not smaller than the source")
  })

  it("摘要长度和语言只改尾部提示词", () => {
    const custom = buildT1Instruction({ maxChars: 1_234, totalChars: 5_678, language: "zh" })
    expect(custom).toContain("under 1234 characters")
    expect(custom).toContain("under 5678 characters")
    expect(custom).toContain("Write the summary in Chinese")
    expect(buildT1Instruction({ language: "en" })).toContain("Write the summary in English")
    expect(buildT1Instruction({ language: "auto" })).toContain("source conversation's primary language")
    expect(custom.startsWith(buildT1Instruction().split("\n")[0] ?? "")).toBe(true)
  })

  it("合并提示词也带长度和语言约束", () => {
    const prompt = buildMergeInstruction(
      [{ index: 1, description: "b1+b2", sourceChars: 10_000, tier: 2 }],
      { maxChars: 800, totalChars: 2_000, language: "en" },
    )
    expect(prompt).toContain("under 800 characters")
    expect(prompt).toContain("under 2000 characters")
    expect(prompt).toContain("Write the summary in English")
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
          result: "x".repeat(20_000),
        })),
      ],
    },
    message("user", "continue", "m3"),
  ]

  it("纯文本不够但工具输出足够时仍然触发", async () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: { contextLimit: 20_000, triggerPercent: 60, summaryBudgetTokens: 5_000 } })
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
    const storage = memoryStorage({ [SETTINGS_KEY]: { contextLimit: 20_000, triggerPercent: 60, summaryBudgetTokens: 5_000 } })
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
      [SETTINGS_KEY]: { contextLimit: 20_000, triggerPercent: 60, summaryBudgetTokens: 5_000 },
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

  it("压缩进行中不再自动入队", async () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: { contextLimit: 20_000, triggerPercent: 60, summaryBudgetTokens: 5_000 } })
    let compacts = 0
    const ctx = fakeCtx(
      storage,
      () => Promise.resolve({ text: JSON.stringify(summary) }),
      () => {
        compacts += 1
        return Promise.resolve()
      },
    )
    markCompactionInFlight("ses_test", true)
    try {
      await maybeAutoCompress({
        ctx,
        sessionID: "ses_test",
        messages: autoMessages(),
        system: [],
        tools: {},
        model: { providerID: "test", id: "test" },
      })
    } finally {
      markCompactionInFlight("ses_test", false)
    }
    expect(compacts).toBe(0)
  })

  it("压缩指令本身不再触发自动压缩", async () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: { contextLimit: 20_000, triggerPercent: 60, summaryBudgetTokens: 5_000 } })
    let compacts = 0
    const ctx = fakeCtx(
      storage,
      () => Promise.resolve({ text: JSON.stringify(summary) }),
      () => {
        compacts += 1
        return Promise.resolve()
      },
    )
    const messages = [...autoMessages().slice(0, -1), message("user", buildT1Instruction(), "m3")]
    await maybeAutoCompress({
      ctx,
      sessionID: "ses_test",
      messages,
      system: [],
      tools: {},
      model: { providerID: "test", id: "test" },
    })
    expect(compacts).toBe(0)
  })

  it("失败次数达到上限后不再自动入队", async () => {
    const storage = memoryStorage({
      [SETTINGS_KEY]: { contextLimit: 20_000, triggerPercent: 60, summaryBudgetTokens: 5_000 },
      [stateKey("ses_test")]: { v: 1, blocks: [], attempts: 3 },
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
    expect(compacts).toBe(0)
  })

  it("pending 或 phase 非空时不再入队", async () => {
    for (const initial of [
      withPending({ v: 1, blocks: [], attempts: 0 }, block),
      withPhase({ v: 1, blocks: [], attempts: 0 }, "t2"),
    ]) {
      const storage = memoryStorage({
        [SETTINGS_KEY]: { contextLimit: 20_000, triggerPercent: 60, summaryBudgetTokens: 5_000 },
        [stateKey("ses_test")]: initial,
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
      expect(compacts).toBe(0)
    }
  })

  it("模型窗口未知时不自动入队", async () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: { contextLimit: "auto", triggerPercent: 60 } })
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
    expect(compacts).toBe(0)
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

  it("总字符超限也排 T2", () => {
    const blocks = [tierBlock("b1", 1, 1), tierBlock("b2", 1, 2)]
    expect(planT1Phase("x".repeat(1_000), blocks, 999_999, 500)).toBe("t2")
    expect(planT1Phase("x".repeat(1_000), blocks, 999_999, 2_000)).toBeUndefined()
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
        compact: () => Promise.resolve(),
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

  it("失败事件保留 pending 和 phase 重试，超过上限才丢弃", async () => {
    const storage = memoryStorage({
      [stateKey("ses_event")]: withPhase(
        withPending({ v: 1, blocks: [], attempts: 0 }, block),
        "t2",
      ),
    })
    await handleCompactionEvent(eventCtx(storage, ""), "failed", "ses_event")
    const first = await loadState(storage, "ses_event")
    expect(first.pending?.id).toBe("b1")
    expect(first.phase).toBe("t2")
    expect(first.attempts).toBe(1)

    await handleCompactionEvent(eventCtx(storage, ""), "failed", "ses_event")
    await handleCompactionEvent(eventCtx(storage, ""), "failed", "ses_event")
    const final = await loadState(storage, "ses_event")
    expect(final.pending).toBeUndefined()
    expect(final.phase).toBeUndefined()
    expect(final.attempts).toBe(3)
  })

  it("永久错误与瞬时错误分类", () => {
    expect(isPermanentFailure("nothing to compress")).toBe(true)
    expect(isPermanentFailure("empty field: goal")).toBe(true)
    expect(isPermanentFailure("summary too short")).toBe(true)
    expect(isPermanentFailure("network down")).toBe(false)
  })

  it("读取最新 checkpoint 失败时保留 pending", async () => {
    const storage = memoryStorage({
      [stateKey("ses_event")]: withPending({ v: 1, blocks: [], attempts: 0 }, block),
    })
    const ctx = {
      storage,
      session: {
        context: () => Promise.reject(new Error("boom")),
        compact: () => Promise.resolve(),
      },
    } as unknown as Plugin.Context
    await handleCompactionEvent(ctx, "ended", "ses_event")
    const state = await loadState(storage, "ses_event")
    expect(state.pending?.id).toBe("b1")
  })

  it("retryState 未到上限保留状态，到上限丢弃", () => {
    const initial = withPhase(withPending({ v: 1, blocks: [], attempts: 0 }, block), "t2")
    const first = retryState(initial, "boom")
    expect(first.retry).toBe(true)
    expect(first.state.pending?.id).toBe("b1")
    expect(first.state.phase).toBe("t2")
    expect(first.state.attempts).toBe(1)

    const last = retryState({ ...initial, attempts: 2 }, "boom")
    expect(last.retry).toBe(false)
    expect(last.state.pending).toBeUndefined()
    expect(last.state.phase).toBeUndefined()
    expect(last.state.attempts).toBe(3)
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
  const toolCtx = (
    storage: StorageLike,
    compact: () => Promise<void> = () => Promise.resolve(),
  ): { ctx: Plugin.Context; tool: () => ToolDefinition } => {
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
        compact,
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

  it("缓存已经是 eligible 时直接使用，不再二次筛选", async () => {
    const storage = memoryStorage()
    const { ctx, tool } = toolCtx(storage)
    const eligible = [
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
    ]
    await registerCompressTool(ctx, new Map([["ses_test", eligible]]))
    const result = await tool().execute(summary, { sessionID: "ses_test" })
    expect(result.output?.block).toBe("b1")
    expect((await loadState(storage, "ses_test")).pending?.id).toBe("b1")
  })

  it("无 eligible 时失败，且返回合法 output", async () => {
    const storage = memoryStorage()
    const { ctx, tool } = toolCtx(storage)
    await registerCompressTool(ctx, new Map())
    const result = await tool().execute(summary, { sessionID: "ses_test" })
    expect(result.content).toContain("nothing to compress")
    expect(result.output).toEqual({ block: "", status: "error" })
  })

  it("内容不足时失败", async () => {
    const storage = memoryStorage()
    const { ctx, tool } = toolCtx(storage)
    await registerCompressTool(
      ctx,
      new Map([["ses_test", [message("user", "hi", "m1"), message("assistant", "short", "m2")]]]),
    )
    const result = await tool().execute(summary, { sessionID: "ses_test" })
    expect(result.content).toContain("not enough content")
  })

  it("摘要非法时失败", async () => {
    const storage = memoryStorage()
    const { ctx, tool } = toolCtx(storage)
    await registerCompressTool(ctx, new Map([["ses_test", toolMessages()]]))
    const result = await tool().execute({ ...summary, goal: "" }, { sessionID: "ses_test" })
    expect(result.content).toContain("empty field: goal")
  })

  it("消息缺少 id 时失败", async () => {
    const storage = memoryStorage()
    const { ctx, tool } = toolCtx(storage)
    const noIds: MessageLike[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: Array.from({ length: 3 }, () => ({
          type: "tool-result",
          name: "shell",
          result: "x".repeat(6_000),
        })),
      },
    ]
    await registerCompressTool(ctx, new Map([["ses_test", noIds]]))
    const result = await tool().execute(summary, { sessionID: "ses_test" })
    expect(result.content).toContain("messages are missing ids")
  })

  it("按设置的单条上限拒绝过长摘要", async () => {
    const storage = memoryStorage({
      [SETTINGS_KEY]: {
        contextLimit: "auto",
        triggerPercent: 80,
        summaryBudgetTokens: 50_000,
        summaryBlockChars: 600,
        summaryTotalChars: 100_000,
        summaryLanguage: "auto",
      },
    })
    const { ctx, tool } = toolCtx(storage)
    await registerCompressTool(ctx, new Map([["ses_test", toolMessages()]]))
    const bigFacts = { ...summary, facts: ["x".repeat(2_000)] }
    const result = await tool().execute(bigFacts, { sessionID: "ses_test" })
    expect(result.content).toContain("summary too long")
  })

  it("compact 失败时记录 lastError 并返回失败", async () => {
    const storage = memoryStorage()
    const { ctx, tool } = toolCtx(storage, () => Promise.reject(new Error("boom")))
    await registerCompressTool(ctx, new Map([["ses_test", toolMessages()]]))
    const result = await tool().execute(summary, { sessionID: "ses_test" })
    expect(result.content).toContain("failed to start compaction")
    expect((await loadState(storage, "ses_test")).lastError).toContain("boom")
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

  it("合并摘要失败时抛出原因", async () => {
    const ctx = fakeCtx(
      memoryStorage(),
      () => Promise.resolve({ text: "not json" }),
      () => Promise.resolve(),
    )
    await expect(
      distillOnce({
        ctx,
        sessionID: "ses_test",
        state: { v: 1, blocks: [longBlock("b1", 1, 1)], attempts: 0 },
        pending: longBlock("b2", 1, 2),
        budgetTokens: 5_000,
        phase: "t2",
      }),
    ).rejects.toThrow("not valid JSON")
  })

  it("总字符超限时也合并", async () => {
    const ctx = fakeCtx(
      memoryStorage(),
      () => Promise.resolve({ text: JSON.stringify({ candidate: 1, ...summary }) }),
      () => Promise.resolve(),
    )
    const result = await distillOnce({
      ctx,
      sessionID: "ses_test",
      state: { v: 1, blocks: [tierBlock("b1", 1, 1), tierBlock("b2", 1, 2)], attempts: 0 },
      pending: undefined,
      budgetTokens: 999_999,
      summaryTotalChars: 10,
      summaryBlockChars: 20_000,
      phase: "t2",
    })
    expect(result.merged).toBe(true)
  })

  it("模型选择不存在的候选时抛出原因", async () => {
    const ctx = fakeCtx(
      memoryStorage(),
      () => Promise.resolve({ text: JSON.stringify({ candidate: 99, ...summary }) }),
      () => Promise.resolve(),
    )
    await expect(
      distillOnce({
        ctx,
        sessionID: "ses_test",
        state: { v: 1, blocks: [longBlock("b1", 1, 1)], attempts: 0 },
        pending: longBlock("b2", 1, 2),
        budgetTokens: 5_000,
        phase: "t2",
      }),
    ).rejects.toThrow("valid candidate")
  })

  it("合并摘要校验失败时抛出原因", async () => {
    const ctx = fakeCtx(
      memoryStorage(),
      () => Promise.resolve({ text: JSON.stringify({ candidate: 1, ...summary, goal: "" }) }),
      () => Promise.resolve(),
    )
    await expect(
      distillOnce({
        ctx,
        sessionID: "ses_test",
        state: { v: 1, blocks: [longBlock("b1", 1, 1)], attempts: 0 },
        pending: longBlock("b2", 1, 2),
        budgetTokens: 5_000,
        phase: "t2",
      }),
    ).rejects.toThrow("empty field: goal")
  })

})
