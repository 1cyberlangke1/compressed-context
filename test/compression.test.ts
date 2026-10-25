import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Schema } from "effect"
import type { Plugin } from "@opencode/plugin"

import { CONFIG_FILE } from "../src/shared/config-paths.ts"

/** 测试里只作为 JSONC 的旧键名，插件本身不再读 storage 设置。 */
const SETTINGS_KEY = "settings"

import { maybeAutoCompress, maybeAutoCompressStep } from "../src/compression/auto.ts"
import { markCompactionInFlight } from "../src/compression/inflight.ts"
import { distillOnce, groupCandidates, pickMergeGroup, planT1Phase } from "../src/compression/distill.ts"
import { handleCompactionEvent } from "../src/compression/events.ts"
import { handleCompaction, type CompactionEvent } from "../src/compression/compaction.ts"
import { EFFECTIVE_WINDOW_KEY, effectiveWindowKey, parseServerSettings } from "../src/compression/settings.ts"
import { activeBlocks, blockMarker, renderAll, renderBlock } from "../src/compression/render.ts"
import { resolveDecompress } from "../src/compression/decompress.ts"
import { loadTranscriptManifest } from "../src/compression/transcript-store.ts"
import { countText } from "../src/shared/tokens.ts"
import { isBabelSummary, isMarkdownSummary, type Summary, type SummaryFields } from "../src/compression/schema.ts"
import { eligibleMessages, isCheckpoint, olderMessages, textChars, type MessageLike } from "../src/compression/select.ts"
import { commitPending, dropPending, loadState, MAX_DISTILL_ROUNDS, parseState, saveState, stateKey, withPending, type Block, type CompactionPhase, type State, type StorageLike } from "../src/compression/state.ts"
import {
  buildMergeInstruction,
  buildT1Instruction,
  sessionGenerator,
  summarizeChoiceInstruction,
  summarizeInstruction,
} from "../src/compression/summarize.ts"
import { registerCompressTool } from "../src/compression/tool.ts"
import { buildTranscript } from "../src/compression/transcript.ts"
import { minSummaryChars, validateSummary } from "../src/compression/validate.ts"

/** 输入：摘要；输出：JSON 字段；Markdown/Babel 摘要返回 undefined。 */
function jsonSummary(summary: Summary | undefined): SummaryFields | undefined {
  return summary !== undefined && !isMarkdownSummary(summary) && !isBabelSummary(summary) ? summary : undefined
}

/** 测试辅助：显式设置/清空 phase；生产代码不再使用 withPhase。 */
function withPhase(state: State, phase: CompactionPhase | undefined): State {
  return {
    blocks: state.blocks,
    attempts: state.attempts,
    ...(state.pending === undefined ? {} : { pending: state.pending }),
    ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
    ...(phase === undefined ? {} : { phase }),
  }
}

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
  height: 1,
  summary,
  fromId: "m1",
  toId: "m9",
  sourceTokens: 1000,
  summaryTokens: 100,
  at: 1,
  order: 1,
}

const message = (role: string, text: string, id?: string): MessageLike => ({
  id,
  role,
  content: [{ type: "text", text }],
})

/** 输入：id/tier/order；输出：测试用块。 */
const tierBlock = (id: string, tier: number, order: number): Block => ({
  ...block,
  id,
  tier,
  height: tier,
  order,
})

/** 输入：id/tier/order；输出：摘要大到足以超过预算的块。 */
const longBlock = (id: string, tier: 1 | 2 | 3, order: number): Block => ({
  ...tierBlock(id, tier, order),
  summary: { ...summary, facts: ["x".repeat(24_000)] },
})

/** 测试 storage 对应的临时 JSONC 目录。 */
const configDirectories = new WeakMap<StorageLike, string>()

/** 输入：初始键值；输出：内存版 StorageLike。预期：settings 落成临时 JSONC 文件。 */
function memoryStorage(initial: Record<string, unknown> = {}): StorageLike {
  const values = new Map<string, Schema.Json>(Object.entries(initial) as [string, Schema.Json][])
  const directory = mkdtempSync(join(tmpdir(), "cc-settings-"))
  const settings = initial[SETTINGS_KEY]
  if (settings !== undefined) {
    const opencode = join(directory, ".opencode")
    mkdirSync(opencode, { recursive: true })
    writeFileSync(join(opencode, CONFIG_FILE), JSON.stringify(settings), "utf8")
  }
  const storage: StorageLike = {
    get: (key) => Promise.resolve(values.get(key)),
    set: (key, value) => {
      if (key === SETTINGS_KEY) {
        const opencode = join(directory, ".opencode")
        mkdirSync(opencode, { recursive: true })
        writeFileSync(join(opencode, CONFIG_FILE), JSON.stringify(value), "utf8")
        return Promise.resolve()
      }
      values.set(key, value)
      return Promise.resolve()
    },
    remove: (key) => {
      values.delete(key)
      return Promise.resolve()
    },
  }
  configDirectories.set(storage, directory)
  return storage
}

/** 输入：storage / 摘要回复 / compact 回调；输出：够自动压缩和 distill 用的假 ctx。 */
function fakeCtx(
  storage: StorageLike,
  text: (input: { prompt: string }) => Promise<{ text: string }>,
  compact: () => Promise<void>,
  usage?: number,
  contextMessages?: readonly unknown[],
  parentID?: string,
): Plugin.Context {
  const measured =
    contextMessages !== undefined
      ? { context: () => Promise.resolve(contextMessages) }
      : usage === undefined
        ? {}
        : {
            context: () =>
              Promise.resolve([
                {
                  type: "assistant",
                  tokens: {
                    input: usage,
                    output: 0,
                    reasoning: 0,
                    cache: { read: 0, write: 0 },
                  },
                },
              ]),
          }
  return {
    storage,
    location: { directory: configDirectories.get(storage) ?? tmpdir() },
    model: { list: () => Promise.resolve({ data: [] }) },
    generate: { text },
    session: {
      compact,
      generate: (input: { sessionID: string; prompt: string }) => text({ prompt: input.prompt }),
      // 默认会话属于本实例目录（守卫放行）；个别用例可覆盖成别的目录或 undefined。
      get: () =>
        Promise.resolve({
          location: { directory: configDirectories.get(storage) ?? tmpdir() },
          ...(parentID === undefined ? {} : { parentID }),
        }),
      ...measured,
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
    const state = withPending({ blocks: [], attempts: 0 }, block)
    expect(commitPending(state).blocks).toHaveLength(1)
    expect(commitPending(state).pending).toBeUndefined()
    expect(dropPending(state, "boom")).toMatchObject({ attempts: 1, lastError: "boom" })
    expect(dropPending(state, "boom").blocks).toHaveLength(0)
  })

  it("损坏的状态回退为空", () => {
    expect(parseState(undefined)).toEqual({ blocks: [], attempts: 0 })
    expect(parseState({ v: 2 })).toEqual({ blocks: [], attempts: 0 })
    expect(parseState({ blocks: [{}] }).blocks).toEqual([])
  })

  it("缺 title 的旧块直接丢弃，不做迁移", () => {
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
    expect(parseState({ blocks: [legacy], attempts: 0 }).blocks).toEqual([])
  })

  it("phase 在提交时保留、失败时清掉", () => {
    const pending = withPending({ blocks: [], attempts: 0, phase: 2 }, block)
    expect(commitPending(pending).phase).toBe(2)
    expect(dropPending(pending, "boom").phase).toBeUndefined()
    expect(withPhase(pending, undefined).phase).toBeUndefined()
    expect(parseState({ blocks: [], attempts: 0, phase: 3 }).phase).toBe(3)
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
    expect(titled.startsWith(`${blockMarker("b1")} [T1] {h1} 压缩内核`)).toBe(true)
    expect(titled).toContain(blockMarker("b1"))
  })

  it("块头显示层级与合并来源", () => {
    const merged = renderBlock({ ...block, id: "b3", tier: 2, height: 2, sourceBlockIds: ["b1", "b2"] })
    expect(merged.startsWith(`${blockMarker("b3")} [T2] {h2} · merged #b1 + #b2`)).toBe(true)
  })

  it("token 估算与时间线只在开关打开时出现", () => {
    const at = new Date(2026, 9, 20, 10, 30).getTime()
    const plain = renderBlock({ ...block, at })
    expect(plain).not.toContain("≈")
    expect(plain).not.toContain("2026/10/20")

    const withMeta = renderBlock({ ...block, at }, { showBlockTokens: true, showTimeline: true })
    expect(withMeta).toContain("≈")
    expect(withMeta).toContain("tok")
    expect(withMeta).toContain("2026/10/20 10:30")
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
    expect(parseServerSettings({ triggerPercent: 80 })).toEqual({
      models: {},
      triggerPercent: 80,
      nudgeGrowthTokens: 50_000,
      summaryBlockPercent: 10,
      summaryTotalPercent: 50,
      recentT1Blocks: 2,
      summaryLanguage: "auto",
      summaryFormat: "markdown",
      autoCompress: true,
      enableCompressTool: true,
      enableDecompressTool: true,
      enableCheckpointTreeTool: true,
      showTimeline: false,
      showBlockTokens: false,
      decompressInlineMax: 10_000,
      decompressTempCap: 50,
      decompressTempMaxAgeHours: 24,
      decompressShowTokens: true,
    })
    expect(
      parseServerSettings({
        triggerPercent: 95,
        summaryBlockPercent: 30,
        summaryTotalPercent: 60,
      recentT1Blocks: 2,
        summaryLanguage: "zh",
      }),
    ).toEqual({
      models: {},
      triggerPercent: 95,
      nudgeGrowthTokens: 50_000,
      summaryBlockPercent: 30,
      summaryTotalPercent: 60,
      recentT1Blocks: 2,
      summaryLanguage: "zh",
      summaryFormat: "markdown",
      autoCompress: true,
      enableCompressTool: true,
      enableDecompressTool: true,
      enableCheckpointTreeTool: true,
      showTimeline: false,
      showBlockTokens: false,
      decompressInlineMax: 10_000,
      decompressTempCap: 50,
      decompressTempMaxAgeHours: 24,
      decompressShowTokens: true,
    })
    expect(parseServerSettings({ triggerPercent: 59 })).toBeUndefined()
    expect(parseServerSettings({ triggerPercent: 96 })).toBeUndefined()
    // 全局 contextLimit 已移除：旧配置里残留的键不再参与解析，也不会让整份设置失效。
    expect(parseServerSettings({ contextLimit: 49_999, triggerPercent: 80 })).toBeDefined()
    expect(parseServerSettings({ contextLimit: "nope", triggerPercent: 80 })).toBeDefined()
  })

  it("按模型覆盖随设置一起解析，非法条目被丢弃", () => {
    // 服务端必须拿到 models，否则按模型设置只在面板生效、压缩时退回全局值。
    expect(
      parseServerSettings({
        triggerPercent: 80,
        models: {
          "a/b": { contextLimit: 200_000, triggerPercent: 88, summaryTotalPercent: 12 },
          c: { triggerPercent: 999 },
          d: "nope",
        },
      })?.models,
    ).toEqual({ "a/b": { contextLimit: 200_000, triggerPercent: 88, summaryTotalPercent: 12 } })
    expect(parseServerSettings({ triggerPercent: 80, models: { c: { contextLimit: 49_999 } } })?.models).toEqual({})
  })

  it("拒绝任意非法摘要百分比和语言", () => {
    const base = { triggerPercent: 80 }
    for (const bad of [0, 91, Number.NaN, Number.POSITIVE_INFINITY, -1, "20"]) {
      expect(parseServerSettings({ ...base, summaryBlockPercent: bad })).toBeUndefined()
    }
    for (const bad of [0, 91, Number.NaN, Number.POSITIVE_INFINITY, -1, "60"]) {
      expect(parseServerSettings({ ...base, summaryTotalPercent: bad })).toBeUndefined()
    }
    expect(parseServerSettings({ ...base, summaryLanguage: "fr" })).toBeUndefined()
  })

  it("nudge 与触发百分比的边界按闭区间判定", () => {
    const base = { triggerPercent: 80 }
    // 0 表示关闭提醒；1k / 200k 是闭区间端点。
    expect(parseServerSettings({ ...base, nudgeGrowthTokens: 0 })?.nudgeGrowthTokens).toBe(0)
    expect(parseServerSettings({ ...base, nudgeGrowthTokens: 1_000 })?.nudgeGrowthTokens).toBe(1_000)
    expect(parseServerSettings({ ...base, nudgeGrowthTokens: 200_000 })?.nudgeGrowthTokens).toBe(200_000)
    expect(parseServerSettings({ ...base, nudgeGrowthTokens: 999 })).toBeUndefined()
    expect(parseServerSettings({ ...base, nudgeGrowthTokens: 200_001 })).toBeUndefined()
    // 不做取整：小数越界仍然拒绝。
    expect(parseServerSettings({ ...base, nudgeGrowthTokens: 200_000.4 })).toBeUndefined()

    expect(parseServerSettings({ ...base, triggerPercent: 60 })?.triggerPercent).toBe(60)
    expect(parseServerSettings({ ...base, triggerPercent: 95 })?.triggerPercent).toBe(95)
    expect(parseServerSettings({ ...base, triggerPercent: 59.9 })).toBeUndefined()
    expect(parseServerSettings({ ...base, triggerPercent: 95.1 })).toBeUndefined()
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
    const result = await summarizeInstruction({
      prompt: "x",
      sourceChars: 10_000,
      generate: { text: () => Promise.resolve({ text: "```json\n" + JSON.stringify(summary) + "\n```" }) },
    })
    expect(jsonSummary(result)?.goal).toBe(summary.goal)
  })

  it("第一次坏 JSON 时重试一次", async () => {
    let calls = 0
    const result = await summarizeInstruction({
      prompt: "x",
      sourceChars: 10_000,
      generate: {
        text: () => {
          calls += 1
          return Promise.resolve({ text: calls === 1 ? "not json" : JSON.stringify(summary) })
        },
      },
    })
    expect(calls).toBe(2)
    expect(jsonSummary(result)?.goal).toBe(summary.goal)
  })

  it("两次都失败时抛出解析原因", async () => {
    await expect(
      summarizeInstruction({
        prompt: "x",
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
    const result = await summarizeChoiceInstruction({
      prompt: "b1 + b2",
      candidates: [{ index: 1, description: "b1+b2 → T2", sourceChars: 10_000, tier: 2 }],
      generate: {
        text: () => Promise.resolve({ text: JSON.stringify({ candidate: 1, ...summary }) }),
      },
    })
    expect(result?.candidate.index).toBe(1)
    expect(jsonSummary(result?.summary)?.goal).toBe(summary.goal)
  })

  it("多候选返回越界 candidate 时判失败，不改用最后一个候选", async () => {
    let failures: string[] = []
    await expect(
      summarizeChoiceInstruction({
        prompt: "b1 + b2",
        candidates: [
          { index: 1, description: "b1", sourceChars: 10_000, tier: 2 },
          { index: 2, description: "b1+b2", sourceChars: 10_000, tier: 2 },
        ],
        generate: { text: () => Promise.resolve({ text: JSON.stringify({ candidate: 99, ...summary }) }) },
        onFailure: (reason) => {
          failures = [...failures, reason]
        },
      }),
    ).rejects.toThrow("outside 1..2")
    expect(failures).toHaveLength(1)
  })

  it("candidate 不是数字时判失败", async () => {
    let failures: string[] = []
    await expect(
      summarizeChoiceInstruction({
        prompt: "b1 + b2",
        candidates: [{ index: 1, description: "b1", sourceChars: 10_000, tier: 2 }],
        generate: { text: () => Promise.resolve({ text: JSON.stringify({ candidate: "1", ...summary }) }) },
        onFailure: (reason) => {
          failures = [...failures, reason]
        },
      }),
    ).rejects.toThrow("not valid JSON with a valid candidate")
    expect(failures).toHaveLength(1)
  })

  it("T2 连续两次坏 JSON 后第三次成功", async () => {
    let calls = 0
    const result = await summarizeChoiceInstruction({
      prompt: "b1 + b2",
      candidates: [{ index: 1, description: "b1+b2 → T2", sourceChars: 10_000, tier: 2 }],
      generate: {
        text: () => {
          calls += 1
          return Promise.resolve({
            text: calls < 3 ? "not json" : JSON.stringify({ candidate: 1, ...summary }),
          })
        },
      },
    })
    expect(calls).toBe(3)
    expect(result?.candidate.index).toBe(1)
    expect(jsonSummary(result?.summary)?.goal).toBe(summary.goal)
  })

  it("解析前后带说明的 JSON", async () => {
    const result = await summarizeInstruction({
      prompt: "x",
      sourceChars: 10_000,
      generate: {
        text: () =>
          Promise.resolve({
            text: `Here is the checkpoint:\n${JSON.stringify(summary)}\nDone.`,
          }),
      },
    })
    expect(jsonSummary(result)?.goal).toBe(summary.goal)
  })

  it("补齐缺失字段和字符串数组", async () => {
    const result = await summarizeInstruction({
      prompt: "x",
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
    expect(jsonSummary(result)?.facts).toHaveLength(1)
    expect(jsonSummary(result)?.progress).toEqual({ completed: [], active: [], blocked: [] })
    expect(jsonSummary(result)?.constraints).toEqual([])
  })

  it("解析双编码 JSON", async () => {
    const result = await summarizeInstruction({
      prompt: "x",
      sourceChars: 10_000,
      generate: { text: () => Promise.resolve({ text: JSON.stringify(JSON.stringify(summary)) }) },
    })
    expect(jsonSummary(result)?.goal).toBe(summary.goal)
  })

  it("修复截断 JSON", async () => {
    const large = { ...summary, goal: "g".repeat(300) }
    const result = await summarizeInstruction({
      prompt: "x",
      sourceChars: 10_000,
      generate: { text: () => Promise.resolve({ text: JSON.stringify(large).slice(0, -1) }) },
    })
    expect(jsonSummary(result)?.goal).toHaveLength(300)
  })

  it("超长 title 自动截断", async () => {
    const result = await summarizeInstruction({
      prompt: "x",
      sourceChars: 10_000,
      generate: {
        text: () => Promise.resolve({ text: JSON.stringify({ ...summary, title: "x".repeat(100) }) }),
      },
    })
    expect(result?.title).toHaveLength(80)
  })

  it("空 goal 抛出精确原因", async () => {
    await expect(
      summarizeInstruction({
        prompt: "x",
        sourceChars: 10_000,
        generate: { text: () => Promise.resolve({ text: JSON.stringify({ ...summary, goal: "" }) }) },
      }),
    ).rejects.toThrow("empty field: goal")
  })

  it("摘要超过 maxChars 时抛出精确原因", async () => {
    await expect(
      summarizeInstruction({
        prompt: "x",
        sourceChars: 10_000,
        maxChars: 100,
        generate: { text: () => Promise.resolve({ text: JSON.stringify(summary) }) },
      }),
    ).rejects.toThrow("summary too long")
  })

  it("摘要不小于原文时抛出精确原因", async () => {
    await expect(
      summarizeInstruction({
        prompt: "x",
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
    const prompt = buildMergeInstruction({
      targetTier: 2,
      blocks: [{ id: "b1", tier: 1, title: "t1", goal: "g1" }],
      options: { maxChars: 800, totalChars: 2_000, language: "en" },
    })
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
    expect(jsonSummary(result)?.goal).toBe(summary.goal)
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
        ...Array.from({ length: 6 }, () => ({
          type: "tool-result",
          name: "shell",
          result: "x".repeat(20_000),
        })),
      ],
    },
    message("user", "continue", "m3"),
  ]

  it("纯文本不够但工具输出足够时仍然触发", async () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: { models: { test: { contextLimit: 50_000 }, model: { contextLimit: 50_000 } }, triggerPercent: 60 } })
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

  it("真实 usage 达到阈值时触发，即使文本估算很小", async () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: { models: { test: { contextLimit: 50_000 }, model: { contextLimit: 50_000 } }, triggerPercent: 60 } })
    let compacts = 0
    const ctx = fakeCtx(
      storage,
      () => Promise.resolve({ text: JSON.stringify(summary) }),
      () => {
        compacts += 1
        return Promise.resolve()
      },
      40_000,
    )
    await maybeAutoCompress({
      ctx,
      sessionID: "ses_test",
      messages: [
        message("user", "hi", "m1"),
        {
          id: "m2",
          role: "assistant",
          content: [{ type: "text", text: "x".repeat(6_000) }],
        },
        message("user", "continue", "m3"),
      ],
      system: [],
      tools: {},
      model: { providerID: "test", id: "test" },
    })
    expect(compacts).toBe(1)
  })

  it("step.ended usage 超阈值时入队并等待压缩落地", async () => {
    const storage = memoryStorage({
      [SETTINGS_KEY]: { models: { test: { contextLimit: 100_000 }, model: { contextLimit: 100_000 } }, triggerPercent: 80 },
      [EFFECTIVE_WINDOW_KEY]: 100_000,
      [stateKey("ses_test")]: { blocks: [], attempts: 0 },
    })
    const base = fakeCtx(
      storage,
      () => Promise.resolve({ text: JSON.stringify(summary) }),
      () => {
        // 模拟 compaction 钩子生命周期：inFlight 置位 → 写 pending → 清除。
        void (async () => {
          markCompactionInFlight("ses_test", true)
          await new Promise((resolve) => setTimeout(resolve, 50))
          const state = await loadState(storage, "ses_test")
          await saveState(storage, "ses_test", withPending(state, { ...block, id: "b1" }))
          await new Promise((resolve) => setTimeout(resolve, 20))
          const pendingState = await loadState(storage, "ses_test")
          await saveState(storage, "ses_test", commitPending(pendingState))
          markCompactionInFlight("ses_test", false)
        })()
        return Promise.resolve()
      },
    )
    await maybeAutoCompressStep({
      ctx: base,
      sessionID: "ses_test",
      tokens: { input: 1, cache: { read: 90_000, write: 0 } },
    })
    // 等待由 background 钩子把 pending 转正。
    for (let index = 0; index < 40 && (await loadState(storage, "ses_test")).blocks.length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const state = await loadState(storage, "ses_test")
    expect(state.blocks.map((item) => item.id)).toEqual(["b1"])
  })

  it("两个实例同时触发自动压缩只入队一次", async () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: { models: { test: { contextLimit: 50_000 }, model: { contextLimit: 50_000 } }, triggerPercent: 60 } })
    let compacts = 0
    const ctx = fakeCtx(
      storage,
      () => Promise.resolve({ text: JSON.stringify(summary) }),
      async () => {
        compacts += 1
        await new Promise((resolve) => setTimeout(resolve, 20))
      },
    )
    const input = {
      ctx,
      sessionID: "ses_test",
      messages: autoMessages(),
      system: [],
      tools: {},
      model: { providerID: "test", id: "test" },
    }

    await Promise.all([maybeAutoCompress(input), maybeAutoCompress(input)])
    expect(compacts).toBe(1)
  })

  it("会话属于别的 location 时 step.ended 不入队", async () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: { models: { test: { contextLimit: 100_000 }, model: { contextLimit: 100_000 } }, triggerPercent: 80 } })
    let compacts = 0
    const ctx = fakeCtx(
      storage,
      () => Promise.resolve({ text: JSON.stringify(summary) }),
      () => {
        compacts += 1
        return Promise.resolve()
      },
    )
    // 会话在其他目录：本实例必须拒绝，否则跨实例事件重复入队压缩。
    ctx.session.get = () =>
      Promise.resolve({ location: { directory: "/other" } }) as unknown as ReturnType<typeof ctx.session.get>
    await maybeAutoCompressStep({
      ctx,
      sessionID: "ses_test",
      tokens: { input: 1, cache: { read: 90_000, write: 0 } },
    })
    expect(compacts).toBe(0)
  })

  it("会话查不到（undefined）时 step.ended 不入队", async () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: { models: { test: { contextLimit: 100_000 }, model: { contextLimit: 100_000 } }, triggerPercent: 80 } })
    let compacts = 0
    const ctx = fakeCtx(
      storage,
      () => Promise.resolve({ text: JSON.stringify(summary) }),
      () => {
        compacts += 1
        return Promise.resolve()
      },
    )
    // 会话查不到说明不是本实例目录的会话；放行 undefined 会导致 home 实例重复入队。
    ctx.session.get = () => Promise.resolve(undefined) as unknown as ReturnType<typeof ctx.session.get>
    await maybeAutoCompressStep({
      ctx,
      sessionID: "ses_test",
      tokens: { input: 1, cache: { read: 90_000, write: 0 } },
    })
    expect(compacts).toBe(0)
  })
  it("压缩成功后没有新 user 消息时 step.ended 不再入队", async () => {
    const storage = memoryStorage({
      [SETTINGS_KEY]: { models: { test: { contextLimit: 100_000 }, model: { contextLimit: 100_000 } }, triggerPercent: 80 },
      [EFFECTIVE_WINDOW_KEY]: 100_000,
      [stateKey("ses_test")]: { blocks: [block], attempts: 0 },
    })
    let compacts = 0
    const ctx = fakeCtx(
      storage,
      () => Promise.resolve({ text: JSON.stringify(summary) }),
      async () => {
        compacts += 1
        const current = await loadState(storage, "ses_test")
        await saveState(storage, "ses_test", { ...current, lastError: "compacted" })
      },
      undefined,
      [
        { type: "compaction", status: "completed", summary: "old" },
        { type: "assistant", content: [{ type: "text", text: "done" }] },
      ],
    )
    await maybeAutoCompressStep({
      ctx,
      sessionID: "ses_test",
      tokens: { input: 1, cache: { read: 90_000, write: 0 } },
    })
    expect(compacts).toBe(0)
  })

  it("压缩后出现新 user 消息时 step.ended 仍然入队", async () => {
    const storage = memoryStorage({
      [SETTINGS_KEY]: { models: { test: { contextLimit: 100_000 }, model: { contextLimit: 100_000 } }, triggerPercent: 80 },
      [EFFECTIVE_WINDOW_KEY]: 100_000,
      [stateKey("ses_test")]: { blocks: [block], attempts: 0 },
    })
    let compacts = 0
    const ctx = fakeCtx(
      storage,
      () => Promise.resolve({ text: JSON.stringify(summary) }),
      async () => {
        compacts += 1
        const current = await loadState(storage, "ses_test")
        await saveState(storage, "ses_test", { ...current, lastError: "compacted" })
      },
      undefined,
      [
        { type: "compaction", status: "completed", summary: "old" },
        { type: "user", text: "new request", files: [] },
      ],
    )
    await maybeAutoCompressStep({
      ctx,
      sessionID: "ses_test",
      tokens: { input: 1, cache: { read: 90_000, write: 0 } },
    })
    expect(compacts).toBe(1)
  })

  it("step.ended usage 低于阈值时不入队", async () => {
    const storage = memoryStorage({
      [SETTINGS_KEY]: { models: { test: { contextLimit: 100_000 }, model: { contextLimit: 100_000 } }, triggerPercent: 80 },
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
    await maybeAutoCompressStep({
      ctx,
      sessionID: "ses_test",
      tokens: { input: 1, cache: { read: 10_000, write: 0 } },
    })
    expect(compacts).toBe(0)
  })

  it("原生窗口 1M 不会放大阈值，settings 100k 仍然生效", async () => {
    const storage = memoryStorage({
      [SETTINGS_KEY]: { models: { test: { contextLimit: 100_000 }, model: { contextLimit: 100_000 } }, triggerPercent: 80 },
      [EFFECTIVE_WINDOW_KEY]: 100_000,
      [stateKey("ses_test")]: { blocks: [], attempts: 0 },
    })
    let compacts = 0
    const ctx = fakeCtx(
      storage,
      () => Promise.resolve({ text: JSON.stringify(summary) }),
      () => {
        compacts += 1
        // 模拟 compaction 钩子生命周期：inFlight 置位 → 写 pending → 清除。
        void (async () => {
          markCompactionInFlight("ses_test", true)
          await new Promise((resolve) => setTimeout(resolve, 100))
          const state = await loadState(storage, "ses_test")
          await saveState(storage, "ses_test", withPending(state, { ...block, id: "b1" }))
          await new Promise((resolve) => setTimeout(resolve, 20))
          const pendingState = await loadState(storage, "ses_test")
          await saveState(storage, "ses_test", commitPending(pendingState))
          markCompactionInFlight("ses_test", false)
        })()
        return Promise.resolve()
      },
    )
    await maybeAutoCompressStep({
      ctx,
      sessionID: "ses_test",
      tokens: { input: 1, cache: { read: 90_000, write: 0 } },
    })
    expect(compacts).toBe(1)
  })

  it("生效窗口缺失时 step.ended 不入队", async () => {
    const storage = memoryStorage({
      [SETTINGS_KEY]: { models: { test: { contextLimit: 100_000 }, model: { contextLimit: 100_000 } }, triggerPercent: 80 },
      [stateKey("ses_test")]: { blocks: [], attempts: 0 },
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
    await maybeAutoCompressStep({
      ctx,
      sessionID: "ses_test",
      tokens: { input: 1, cache: { read: 500_000, write: 0 } },
    })
    expect(compacts).toBe(0)
  })

  it("多会话各自使用自己的生效窗口，不串线", async () => {
    const storage = memoryStorage({
      [SETTINGS_KEY]: { models: { test: { contextLimit: 100_000 }, model: { contextLimit: 100_000 } }, triggerPercent: 80 },
      // 全局值模拟另一个会话刚写入的 100k；ses_a 自己是 50k。
      [EFFECTIVE_WINDOW_KEY]: 100_000,
      [effectiveWindowKey("ses_a")]: 50_000,
      [stateKey("ses_a")]: { blocks: [], attempts: 0 },
    })
    let compacts = 0
    const ctx = fakeCtx(
      storage,
      () => Promise.resolve({ text: JSON.stringify(summary) }),
      () => {
        compacts += 1
        // 抛错终止 waitForCompaction，测试只关心是否越过阈值。
        return Promise.reject(new Error("stop after enqueue"))
      },
    )
    await maybeAutoCompressStep({
      ctx,
      sessionID: "ses_a",
      tokens: { input: 1, cache: { read: 45_000, write: 0 } },
    })
    expect(compacts).toBe(1)
  })

  it("已排下一层蒸馏但预算回落时 step.ended 不入队并清 phase", async () => {
    const storage = memoryStorage({
      [SETTINGS_KEY]: { models: { test: { contextLimit: 100_000 }, model: { contextLimit: 100_000 } }, triggerPercent: 80 },
      [EFFECTIVE_WINDOW_KEY]: 100_000,
      // 没有块 = 摘要 0 token，预算内；旧逻辑会绕过阈值直接入队。
      [stateKey("ses_test")]: { blocks: [], attempts: 0, phase: 2 },
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
    await maybeAutoCompressStep({
      ctx,
      sessionID: "ses_test",
      tokens: { input: 1, cache: { read: 10, write: 0 } },
    })
    expect(compacts).toBe(0)
    const state = await loadState(storage, "ses_test")
    expect(state.phase).toBeUndefined()
  })

  it("已排下一层且摘要仍超预算时 step.ended 直接入队", async () => {
    const storage = memoryStorage({
      [SETTINGS_KEY]: {
        models: { test: { contextLimit: 100_000 }, model: { contextLimit: 100_000 } },
        triggerPercent: 80,
        summaryTotalPercent: 1,
      },
      [EFFECTIVE_WINDOW_KEY]: 100_000,
      // 单块 24k 字符 ≈ 6k token，超过 1% × 100k 的预算……不够，改用更小的窗口百分比。
      [stateKey("ses_test")]: {
        blocks: [longBlock("b1", 1, 1), longBlock("b2", 1, 2)],
        attempts: 0,
        phase: 2,
      },
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
    await maybeAutoCompressStep({
      ctx,
      sessionID: "ses_test",
      tokens: { input: 1, cache: { read: 10, write: 0 } },
    })
    expect(compacts).toBe(1)
  })

  it("phase 为空但摘要超预算时 step.ended 也入队合并（保留区用默认值）", async () => {
    const storage = memoryStorage({
      [SETTINGS_KEY]: {
        models: { test: { contextLimit: 100_000 }, model: { contextLimit: 100_000 } },
        triggerPercent: 80,
        summaryTotalPercent: 1,
      },
      [EFFECTIVE_WINDOW_KEY]: 100_000,
      // 两个块已经超 1% × 100k 的预算，但 phase 为空：旧逻辑只会等用量到 80%。
      // recentT1Blocks 故意不写：默认保留 2 个 T1 时也必须能合（闸门与 distill 选组同源）。
      [stateKey("ses_test")]: { blocks: [longBlock("b1", 1, 1), longBlock("b2", 1, 2)], attempts: 0 },
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
    // 用量远低于阈值，只有摘要超预算这一个理由。
    await maybeAutoCompressStep({
      ctx,
      sessionID: "ses_test",
      tokens: { input: 1, cache: { read: 10, write: 0 } },
    })
    expect(compacts).toBe(1)
    // 同时补上 phase，下一次压缩走合并而不是重复 T1。
    expect((await loadState(storage, "ses_test")).phase).toBe(2)
  })

  it("只剩一个块且超预算时也要入队自压", async () => {
    const storage = memoryStorage({
      [SETTINGS_KEY]: {
        models: { test: { contextLimit: 100_000 }, model: { contextLimit: 100_000 } },
        triggerPercent: 80,
        summaryTotalPercent: 1,
      },
      [EFFECTIVE_WINDOW_KEY]: 100_000,
      // distill 支持「单块自己升一层」，所以只剩一块也不能把这条收缩路径封死。
      [stateKey("ses_test")]: { blocks: [longBlock("b1", 1, 1)], attempts: 0 },
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
    await maybeAutoCompressStep({
      ctx,
      sessionID: "ses_test",
      tokens: { input: 1, cache: { read: 10, write: 0 } },
    })
    expect(compacts).toBe(1)
  })

  it("只有 checkpoint 的 recent 撑大总量时不触发", async () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: { models: { test: { contextLimit: 50_000 }, model: { contextLimit: 50_000 } }, triggerPercent: 60 } })
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
      `<conversation-checkpoint><summary>old</summary><recent-context>${"x".repeat(140_000)}</recent-context></conversation-checkpoint>`,
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
      [SETTINGS_KEY]: { models: { test: { contextLimit: 50_000 }, model: { contextLimit: 50_000 } }, triggerPercent: 60 },
      [stateKey("ses_test")]: { blocks: [block], attempts: 0 },
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

  it("普通会话压出首块后仍会继续自动压缩", async () => {
    const storage = memoryStorage({
      [SETTINGS_KEY]: { models: { test: { contextLimit: 50_000 }, model: { contextLimit: 50_000 } }, triggerPercent: 60 },
      [stateKey("ses_test")]: { blocks: [block], attempts: 0 },
    })
    let compacts = 0
    const ctx = fakeCtx(
      storage,
      () => Promise.resolve({ text: JSON.stringify(summary) }),
      () => {
        compacts += 1
        return Promise.resolve()
      },
      90_000,
    )
    await maybeAutoCompress({
      ctx,
      sessionID: "ses_test",
      messages: autoMessages(),
      system: [],
      tools: {},
      model: { providerID: "test", id: "test" },
    })
    expect(compacts).toBe(1)
  })

  it("压缩进行中不再自动入队", async () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: { models: { test: { contextLimit: 50_000 }, model: { contextLimit: 50_000 } }, triggerPercent: 60 } })
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

  it("pending 非空时不再入队", async () => {
    const storage = memoryStorage({
      [SETTINGS_KEY]: { models: { test: { contextLimit: 50_000 }, model: { contextLimit: 50_000 } }, triggerPercent: 60 },
      [stateKey("ses_test")]: withPending({ blocks: [], attempts: 0 }, block),
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

  it("phase 非空且摘要超预算时下一次模型请求入队合并，不等阈值", async () => {
    const storage = memoryStorage({
      [SETTINGS_KEY]: {
        models: { test: { contextLimit: 50_000 }, model: { contextLimit: 50_000 } },
        triggerPercent: 60,
        summaryTotalPercent: 1,
      },
      // 两个 24k 字符的块 ≈ 12k token，超过 1% × 50k = 500 的摘要预算。
      [stateKey("ses_test")]: withPhase({ blocks: [longBlock("b1", 1, 1), longBlock("b2", 1, 2)], attempts: 0 }, 2),
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
    // 消息量远低于阈值，但摘要确实超预算：必须入队，否则合并永远等不到。
    await maybeAutoCompress({
      ctx,
      sessionID: "ses_test",
      messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }] }],
      system: [],
      tools: {},
      model: { providerID: "test", id: "test" },
    })
    expect(compacts).toBe(1)
  })

  it("phase 为空但摘要超预算时下一次模型请求也入队合并", async () => {
    const storage = memoryStorage({
      [SETTINGS_KEY]: {
        models: { test: { contextLimit: 50_000 }, model: { contextLimit: 50_000 } },
        triggerPercent: 60,
        summaryTotalPercent: 1,
      },
      // 摘要超预算、但没有排下一层：旧逻辑会一直等到用量过线。
      // recentT1Blocks 用默认值（2），两个块也必须能合。
      [stateKey("ses_test")]: { blocks: [longBlock("b1", 1, 1), longBlock("b2", 1, 2)], attempts: 0 },
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
    // 消息量远低于阈值：只有摘要预算这一个触发理由。
    await maybeAutoCompress({
      ctx,
      sessionID: "ses_test",
      messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }] }],
      system: [],
      tools: {},
      model: { providerID: "test", id: "test" },
    })
    expect(compacts).toBe(1)
    expect((await loadState(storage, "ses_test")).phase).toBe(2)
  })

  it("compress 工具关闭时自动压缩仍然生效", async () => {
    const storage = memoryStorage({
      [SETTINGS_KEY]: { models: { test: { contextLimit: 50_000 }, model: { contextLimit: 50_000 } }, triggerPercent: 60, enableCompressTool: false },
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
    expect(compacts).toBe(1)
  })

  /**
   * 输入：走完一刀之后的会话历史（最后一条 compaction 之后有没有新的 user 消息）。
   * 输出：无。
   * 预期：自动压缩只由「有新 user 消息」决定，与 pending/in-flight 的时序无关——
   *       超算和土豆上看到同一个块数，不靠谁先落地。
   */
  it("刚压完还没有新的 user 消息时不再自动压一刀", async () => {
    const storage = memoryStorage({
      [SETTINGS_KEY]: {
        models: { test: { contextLimit: 100_000 }, model: { contextLimit: 100_000 } },
        triggerPercent: 60,
      },
    })
    let compacts = 0
    const ctx = fakeCtx(
      storage,
      () => Promise.resolve({ text: JSON.stringify(summary) }),
      () => {
        compacts += 1
        return Promise.resolve()
      },
      undefined,
      [
        { type: "assistant", tokens: { input: 90_000, output: 0, cache: { read: 0, write: 0 } } },
        { type: "compaction", status: "completed" },
      ],
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

  it("压完之后有新的 user 消息时会继续自动压", async () => {
    const storage = memoryStorage({
      [SETTINGS_KEY]: {
        models: { test: { contextLimit: 100_000 }, model: { contextLimit: 100_000 } },
        triggerPercent: 60,
      },
    })
    let compacts = 0
    const ctx = fakeCtx(
      storage,
      () => Promise.resolve({ text: JSON.stringify(summary) }),
      () => {
        compacts += 1
        return Promise.resolve()
      },
      undefined,
      [
        { type: "assistant", tokens: { input: 90_000, output: 0, cache: { read: 0, write: 0 } } },
        { type: "compaction", status: "completed" },
        { type: "user", text: "next turn" },
      ],
    )
    await maybeAutoCompress({
      ctx,
      sessionID: "ses_test",
      messages: autoMessages(),
      system: [],
      tools: {},
      model: { providerID: "test", id: "test" },
    })
    expect(compacts).toBe(1)
  })

  it("autoCompress 关闭时不入队", async () => {
    const storage = memoryStorage({
      [SETTINGS_KEY]: { models: { test: { contextLimit: 50_000 }, model: { contextLimit: 50_000 } }, triggerPercent: 60, autoCompress: false },
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

  it("phase 已排但预算回落时不再入队，并清掉残留 phase", async () => {
    const storage = memoryStorage({
      [SETTINGS_KEY]: { models: { test: { contextLimit: 50_000 }, model: { contextLimit: 50_000 } }, triggerPercent: 60 },
      [stateKey("ses_test")]: { blocks: [tierBlock("b1", 1, 1)], attempts: 0, phase: 2 },
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
      // 消息量远低于阈值：防止走阈值分支，确保测的是 phase/预算分支。
      messages: [message("user", "hi", "m1"), message("assistant", "ok", "m2")],
      system: [],
      tools: {},
      model: { providerID: "test", id: "test" },
    })
    expect(compacts).toBe(0)
    // 摘要本来就在预算内：phase 必须被清掉，否则每个 step 都会绕过阈值入队压缩。
    const state = await loadState(storage, "ses_test")
    expect(state.phase).toBeUndefined()
  })

  it("模型窗口未知时不自动入队", async () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: { triggerPercent: 60 } })
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

describe("合并分组", () => {
  /** 输入：id/层/顺序/摘要 token 占用；输出：可指定占用的块。 */
  const heavy = (id: string, tier: number, order: number, summaryTokens: number): Block => ({
    ...tierBlock(id, tier, order),
    summaryTokens,
  })

  it("按摘要占用选层：一个大的 T2 压过两个小的 T3", () => {
    const group = pickMergeGroup(
      [heavy("b1", 3, 1, 40), heavy("b2", 3, 2, 40), heavy("b3", 2, 3, 150)],
      0,
    )
    expect(group?.tier).toBe(2)
    expect(group?.blocks.map((item) => item.id)).toEqual(["b3"])
  })

  it("占用相同时取更靠左（更老）的段", () => {
    const group = pickMergeGroup([heavy("b1", 3, 1, 100), heavy("b2", 2, 2, 100)], 0)
    expect(group?.tier).toBe(3)
  })

  it("保留区剔除最新的 N 个 T1", () => {
    const blocks = [
      tierBlock("b1", 1, 1),
      tierBlock("b2", 1, 2),
      tierBlock("b3", 1, 3),
      tierBlock("b4", 1, 4),
    ]
    const group = pickMergeGroup(blocks, 2)
    expect(group?.blocks.map((item) => item.id)).toEqual(["b1", "b2"])
  })

  it("保留区吃光候选时让位到能合两个块，而不是只自压一块", () => {
    const blocks = [tierBlock("b1", 1, 1), tierBlock("b2", 1, 2)]
    const group = pickMergeGroup(blocks, 2)
    expect(group?.blocks.map((item) => item.id)).toEqual(["b1", "b2"])
  })

  it("链为空时没有可合并段", () => {
    expect(pickMergeGroup([], 2)).toBeUndefined()
  })

  it("保留数大于 T1 数量时让位到能合两个块", () => {
    const blocks = [tierBlock("b1", 1, 1), tierBlock("b2", 1, 2), tierBlock("b3", 1, 3)]
    const group = pickMergeGroup(blocks, 10)
    expect(group?.blocks.map((item) => item.id)).toEqual(["b1", "b2"])
  })

  it("只剩一个高层块时给出自压段", () => {
    const group = pickMergeGroup([tierBlock("b1", 2, 1)], 2)
    expect(group?.tier).toBe(2)
    expect(group?.blocks.map((item) => item.id)).toEqual(["b1"])
  })

  it("候选是 1..N 个块的前缀，产物层封顶 3", () => {
    const group = {
      tier: 2,
      blocks: [tierBlock("b1", 2, 1), tierBlock("b2", 2, 2), tierBlock("b3", 2, 3)],
    }
    const candidates = groupCandidates(group)
    expect(candidates.map((candidate) => candidate.index)).toEqual([1, 2, 3])
    expect(candidates.every((candidate) => candidate.tier === 3)).toBe(true)
    expect(candidates[2]?.blocks.map((item) => item.id)).toEqual(["b1", "b2", "b3"])

    const capped = groupCandidates({ tier: 3, blocks: [tierBlock("b1", 3, 1), tierBlock("b2", 3, 2)] })
    expect(capped.every((candidate) => candidate.tier === 3)).toBe(true)
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
  it("预算内或链为空不排合并", () => {
    expect(planT1Phase("short", [tierBlock("b1", 1, 1), tierBlock("b2", 1, 2)], 5_000)).toBeUndefined()
    expect(planT1Phase("x".repeat(30_000), [], 5_000)).toBeUndefined()
  })

  it("超预算且链非空就排合并：最短路径是自己压自己", () => {
    expect(planT1Phase("x".repeat(30_000), [tierBlock("b1", 1, 1)], 5_000)).toBe(2)
    expect(planT1Phase("x".repeat(30_000), [tierBlock("b1", 1, 1), tierBlock("b2", 1, 2)], 5_000)).toBe(2)
  })

  it("只按 token 预算判断，字符数不再参与比较", () => {
    const blocks = [tierBlock("b1", 1, 1), tierBlock("b2", 1, 2)]
    // 1000 个 ASCII 字符 ≈ 250 token：字符数大于预算不代表 token 超预算。
    expect(planT1Phase("x".repeat(1_000), blocks, 5_000)).toBeUndefined()
    // 1000 个汉字 ≈ 1000 token，超过 500 的 token 预算就要排 T2。
    expect(planT1Phase("摘".repeat(1_000), blocks, 500)).toBe(2)
  })
})

describe("会话隔离", () => {
  it("不同 session 的 blocks 和 phase 不串", async () => {
    const storage = memoryStorage()
    await saveState(storage, "ses_a", {
      blocks: [tierBlock("b1", 1, 1)],
      attempts: 0,
      phase: 2,
    })
    await saveState(storage, "ses_b", {
      blocks: [tierBlock("b1", 2, 1)],
      attempts: 0,
    })
    const a = await loadState(storage, "ses_a")
    const b = await loadState(storage, "ses_b")
    expect(a.blocks[0]?.tier).toBe(1)
    expect(a.phase).toBe(2)
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
      [stateKey("ses_event")]: withPending({ blocks: [], attempts: 0 }, block),
    })
    await handleCompactionEvent(eventCtx(storage, blockMarker("b1")), "ended", "ses_event")
    const state = await loadState(storage, "ses_event")
    expect(state.blocks).toHaveLength(1)
    expect(state.pending).toBeUndefined()
  })

  it("晚到事件不提交不属于它的 pending", async () => {
    const storage = memoryStorage({
      [stateKey("ses_event")]: withPending({ blocks: [], attempts: 0 }, block),
    })
    await handleCompactionEvent(eventCtx(storage, "another checkpoint"), "ended", "ses_event")
    const state = await loadState(storage, "ses_event")
    expect(state.blocks).toHaveLength(0)
    expect(state.pending?.id).toBe("b1")
  })

  it("失败事件保留 phase 并记录错误，下一次请求重试", async () => {
    const storage = memoryStorage({
      // 钩子跑过并失败时，catch 已经写过 lastError；这里模拟同样的状态。
      [stateKey("ses_event")]: {
        ...withPhase(withPending({ blocks: [], attempts: 0 }, block), 2),
        lastError: "network down",
      },
    })
    await handleCompactionEvent(eventCtx(storage, ""), "failed", "ses_event", "network down")
    const state = await loadState(storage, "ses_event")
    expect(state.pending).toBeUndefined()
    expect(state.phase).toBe(2)
    expect(state.attempts).toBe(1)
    expect(state.lastError).toContain("network down")
  })

  it("事件 error 优先于 state.lastError（钩子没跑过的失败也能拿到真实原因）", async () => {
    const storage = memoryStorage({
      [stateKey("ses_event")]: withPending({ blocks: [], attempts: 0 }, block),
    })
    await handleCompactionEvent(eventCtx(storage, ""), "failed", "ses_event", "nothing to compress")
    const state = await loadState(storage, "ses_event")
    // 永久错误直接丢弃，不重试
    expect(state.pending).toBeUndefined()
    expect(state.lastError).toContain("nothing to compress")
  })

  it("钩子没跑过的空压缩失败 + 已排 phase：保留 phase 不计失败", async () => {
    const storage = memoryStorage({
      [stateKey("ses_event")]: { blocks: [block], attempts: 0, phase: 2 },
    })
    await handleCompactionEvent(eventCtx(storage, ""), "failed", "ses_event", "Nothing to compact yet")
    const state = await loadState(storage, "ses_event")
    expect(state.phase).toBe(2)
    expect(state.attempts).toBe(0)
    expect(state.blocks).toHaveLength(1)
  })

  it("读取最新 checkpoint 失败时保留 pending", async () => {
    const storage = memoryStorage({
      [stateKey("ses_event")]: withPending({ blocks: [], attempts: 0 }, block),
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
})

describe("缓存尾追加", () => {
  it("T2 指令只追加在会话前缀尾部", () => {
    const prefix = "system\n[checkpoint b1 b2]\nrecent"
    const instruction = buildMergeInstruction({
      targetTier: 2,
      blocks: [{ id: "b1", tier: 1, title: "t1", goal: "g1" }],
    })
    const request = `${prefix}\n${instruction}`
    expect(request.startsWith(prefix)).toBe(true)
    expect(instruction).not.toContain("Sources:")
    expect(instruction).toContain("Block group")
    expect(instruction).toContain("checkpoint")
  })
})

describe("compress 工具只做 T1", () => {
  interface ToolDefinition {
    execute: (
      input: SummaryFields,
      ctx: { sessionID: string },
    ) => Promise<{ content: string; output?: { block?: string; status: string; error?: string } }>
  }

  /** 输入：storage；输出：捕获工具定义。 */
  const toolCtx = (
    storage: StorageLike,
    compact: () => Promise<void> = () => Promise.resolve(),
  ): { ctx: Plugin.Context; tool: () => ToolDefinition } => {
    let definition: ToolDefinition | undefined
    const ctx = {
      storage,
      location: { directory: configDirectories.get(storage) ?? tmpdir() },
      tool: {
        transform: (fn: (tools: { add: (tool: ToolDefinition) => void }) => void) => {
          fn({ add: (tool) => { definition = tool } })
          return Promise.resolve({ dispose: () => Promise.resolve() })
        },
      },
      session: {
        compact,
        // 默认会话是主会话且属于本实例目录；子代理用例可覆盖 get。
        get: () =>
          Promise.resolve({
            location: { directory: configDirectories.get(storage) ?? tmpdir() },
            model: undefined,
          }),
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

  it("子代理会话调用 compress 直接拒绝", async () => {
    const storage = memoryStorage()
    const { ctx, tool } = toolCtx(storage)
    // 覆盖 get：返回带 parentID 的会话，模拟子代理。
    Object.assign(ctx.session as unknown as Record<string, unknown>, {
      get: () =>
        Promise.resolve({
          location: { directory: configDirectories.get(storage) ?? tmpdir() },
          parentID: "ses_parent",
        }),
    })
    await registerCompressTool(ctx, new Map([["ses_test", toolMessages()]]))
    const result = await tool().execute(summary, { sessionID: "ses_test" })
    expect(result.output?.status).toBe("error")
    expect(result.output?.error).toContain("subagent")
    expect(result.output?.block).toBeUndefined()
  })

  it("pending 或 phase 非空时拒绝，不改状态", async () => {
    const pendingStorage = memoryStorage({
      [stateKey("ses_test")]: withPending({ blocks: [], attempts: 0 }, block),
    })
    const pending = toolCtx(pendingStorage)
    await registerCompressTool(pending.ctx, new Map([["ses_test", toolMessages()]]))
    const pendingResult = await pending.tool().execute(summary, { sessionID: "ses_test" })
    expect(pendingResult.content).toContain("compression already in progress")
    expect(pendingResult.output?.error).toContain("compression already in progress")
    expect(pendingResult.output?.block).toBeUndefined()

    const phaseStorage = memoryStorage({
      [stateKey("ses_test")]: withPhase({ blocks: [], attempts: 0 }, 2),
    })
    const phase = toolCtx(phaseStorage)
    await registerCompressTool(phase.ctx, new Map([["ses_test", toolMessages()]]))
    const phaseResult = await phase.tool().execute(summary, { sessionID: "ses_test" })
    expect(phaseResult.content).toContain("compression already in progress")
    expect(phaseResult.output?.error).toContain("compression already in progress")
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
    expect(result.output).toEqual({ status: "error", error: "nothing to compress" })
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
    expect(result.output?.error).toContain("not enough content")
  })

  it("摘要非法时失败", async () => {
    const storage = memoryStorage()
    const { ctx, tool } = toolCtx(storage)
    await registerCompressTool(ctx, new Map([["ses_test", toolMessages()]]))
    const result = await tool().execute({ ...summary, goal: "" }, { sessionID: "ses_test" })
    expect(result.content).toContain("empty field: goal")
    expect(result.output?.error).toContain("empty field: goal")
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
    expect(result.output?.error).toContain("messages are missing ids")
  })

  it("按设置的单条上限拒绝过长摘要", async () => {
    const storage = memoryStorage({
      [SETTINGS_KEY]: {
        triggerPercent: 80,
        summaryBlockPercent: 1,
        summaryTotalPercent: 50,
        summaryLanguage: "auto",
      },
      // 工具路径用最近一次解析到的窗口把百分比换成字符：50k × 1% = 500。
      "window:last": 50_000,
    })
    const { ctx, tool } = toolCtx(storage)
    await registerCompressTool(ctx, new Map([["ses_test", toolMessages()]]))
    const bigFacts = { ...summary, facts: ["x".repeat(2_000)] }
    const result = await tool().execute(bigFacts, { sessionID: "ses_test" })
    expect(result.content).toContain("summary too long")
    expect(result.output?.error).toContain("summary too long")
  })

  it("compress 工具关闭时返回明确错误", async () => {
    const storage = memoryStorage({
      [SETTINGS_KEY]: { models: { test: { contextLimit: 50_000 }, model: { contextLimit: 50_000 } }, triggerPercent: 80, enableCompressTool: false },
    })
    const { ctx, tool } = toolCtx(storage)
    await registerCompressTool(ctx, new Map([["ses_test", toolMessages()]]))
    const result = await tool().execute(summary, { sessionID: "ses_test" })
    expect(result.content).toContain("disabled")
    expect(result.output?.error).toContain("disabled")
  })

  it("compact 失败时记录 lastError 并返回失败", async () => {
    const storage = memoryStorage()
    const { ctx, tool } = toolCtx(storage, () => Promise.reject(new Error("boom")))
    await registerCompressTool(ctx, new Map([["ses_test", toolMessages()]]))
    const result = await tool().execute(summary, { sessionID: "ses_test" })
    expect(result.content).toContain("failed to start compaction")
    expect(result.output?.error).toContain("failed to start compaction")
    expect((await loadState(storage, "ses_test")).lastError).toContain("boom")
  })
})
describe("摘要单层合并", () => {
  it("phase=t2 时新消息很短也合并块，不报 nothing to compress", async () => {
    const storage = memoryStorage()
    await storage.set("settings", {
      models: { test: { contextLimit: 50_000 }, model: { contextLimit: 50_000 } },
      triggerPercent: 60,
      summaryBlockPercent: 20,
      summaryTotalPercent: 1,
      summaryFormat: "json",
    })
    await saveState(storage, "ses_short_t2", {
      blocks: [longBlock("b1", 1, 1), longBlock("b2", 1, 2), longBlock("b3", 1, 3)],
      attempts: 0,
      phase: 2,
    })
    const ctx = fakeCtx(
      storage,
      () => Promise.resolve({ text: JSON.stringify({ candidate: 1, ...summary }) }),
      () => Promise.resolve(),
    )
    const event: CompactionEvent = {
      sessionID: "ses_short_t2",
      model: { providerID: "fake", id: "model" },
      messages: [
        message("user", "<conversation-checkpoint>[T1] old</conversation-checkpoint>", "m0"),
        // older 超过 MIN_SOURCE_CHARS：phase 分支让位给 T1 会走这里？不会——
        // 这 3 条消息里只有 checkpoint 之后的两条短消息，不足 MIN_SOURCE_CHARS，
        // 所以仍走合并分支：这是「新消息不够长也必须能合并」的回归用例。
        message("user", "continue", "m1"),
        message("assistant", "ok", "m2"),
      ],
    }
    await handleCompaction(ctx, event)
    const state = await loadState(storage, "ses_short_t2")
    expect(activeBlocks(state.blocks, state.pending).some((item) => item.tier === 2)).toBe(true)
    expect(state.lastError).toBeUndefined()
    expect(event.result?.summary).toContain("T2")
  })

  it("只剩一个块且超预算时自压，压回预算后清 phase", async () => {
    const storage = memoryStorage()
    await storage.set("settings", {
      models: { test: { contextLimit: 50_000 }, model: { contextLimit: 50_000 } },
      triggerPercent: 60,
      summaryBlockPercent: 20,
      summaryTotalPercent: 1,
      summaryFormat: "json",
    })
    await saveState(storage, "ses_terminal", {
      // 只有一个 T3 且超预算：新算法允许它自压，不再「无候选」卡死。
      blocks: [longBlock("b1", 3, 1)],
      attempts: 2,
      phase: 3,
    })
    const ctx = fakeCtx(
      storage,
      () => Promise.resolve({ text: JSON.stringify({ candidate: 1, ...summary }) }),
      () => Promise.resolve(),
    )
    const event: CompactionEvent = {
      sessionID: "ses_terminal",
      model: { providerID: "fake", id: "model" },
      messages: [
        message("user", "<conversation-checkpoint>[T1] old</conversation-checkpoint>", "m0"),
        message("user", "continue", "m1"),
        message("assistant", "ok", "m2"),
      ],
    }
    await handleCompaction(ctx, event)
    const state = await loadState(storage, "ses_terminal")
    expect(state.lastError).toBeUndefined()
    // 单块也能自压：产物仍是 T3、深度 +1；压回预算内后 phase 正常清空。
    expect(state.pending?.tier).toBe(3)
    expect(state.pending?.sourceBlockIds).toEqual(["b1"])
    expect(state.pending?.height).toBe(4)
    expect(state.phase).toBeUndefined()
    expect(state.blocks).toHaveLength(1)
  })

  it("按占用选层：两个 T1 的占用压过单个 T3", async () => {
    const storage = memoryStorage()
    await storage.set("settings", {
      models: { test: { contextLimit: 50_000 }, model: { contextLimit: 50_000 } },
      triggerPercent: 60,
      summaryBlockPercent: 20,
      summaryTotalPercent: 1,
      recentT1Blocks: 0,
      summaryFormat: "json",
    })
    await saveState(storage, "ses_t3_then_t1", {
      blocks: [longBlock("b1", 3, 1), longBlock("b2", 1, 2), longBlock("b3", 1, 3)],
      attempts: 0,
      phase: 3,
    })
    const ctx = fakeCtx(
      storage,
      () => Promise.resolve({ text: JSON.stringify({ candidate: 2, ...summary }) }),
      () => Promise.resolve(),
    )
    // 两段占用打平（各 100）时取更靠左的 T3；这里 T1 两个块合计 200，所以选 T1 段。
    const event: CompactionEvent = {
      sessionID: "ses_t3_then_t1",
      model: { providerID: "fake", id: "model" },
      messages: [
        message("user", "<conversation-checkpoint>[T3] old</conversation-checkpoint>", "m0"),
        {
          id: "m1",
          role: "assistant",
          content: [
            { type: "text", text: "done" },
            { type: "tool-result", name: "read", result: "x".repeat(10_000) },
          ],
        },
      ],
    }

    await handleCompaction(ctx, event)

    const state = await loadState(storage, "ses_t3_then_t1")
    expect(state.lastError).toBeUndefined()
    expect(event.result?.summary).toBeDefined()
    // T3+b2、T3+b3 跨层不许合；但 b2+b3 是 T1+T1，distill 做了它能做的同层合并。
    // T3 本身没被碰：合出的是 T2，不是把 T3 熬进新块。
    expect(state.pending?.tier).toBe(2)
    expect(state.pending?.sourceBlockIds).toEqual(["b2", "b3"])
    // active = b1(T3) + b4(T2)。
    expect(activeBlocks(state.blocks, state.pending)).toHaveLength(2)
  })

  it("phase 为空时只有大工具输出也照样压 T1，不跳过", async () => {
    const storage = memoryStorage()
    await storage.set("settings", {
      models: { test: { contextLimit: 50_000 }, model: { contextLimit: 50_000 } },
      triggerPercent: 60,
      summaryBlockPercent: 20,
      summaryTotalPercent: 40,
      summaryFormat: "json",
    })
    await saveState(storage, "ses_t1_small", { blocks: [], attempts: 0 })
    const ctx = fakeCtx(
      storage,
      () => Promise.resolve({ text: JSON.stringify(summary) }),
      () => Promise.resolve(),
    )
    const event: CompactionEvent = {
      sessionID: "ses_t1_small",
      model: { providerID: "fake", id: "model" },
      messages: [
        message("user", "start", "m0"),
        {
          id: "m1",
          role: "assistant",
          content: [{ type: "tool-result", name: "read", result: "x".repeat(10_000) }],
        },
      ],
    }

    await handleCompaction(ctx, event)

    const state = await loadState(storage, "ses_t1_small")
    expect(state.lastError).toBeUndefined()
    expect(state.pending?.tier).toBe(1)
    expect(event.result?.summary).toContain(`#${state.pending?.id ?? ""}`)
  })

  it("只剩 checkpoint 时才跳过，并复用现有摘要", async () => {
    const storage = memoryStorage()
    await storage.set("settings", {
      models: { test: { contextLimit: 50_000 }, model: { contextLimit: 50_000 } },
      triggerPercent: 60,
      summaryBlockPercent: 20,
      summaryTotalPercent: 40,
      summaryFormat: "json",
    })
    await saveState(storage, "ses_only_checkpoint", { blocks: [longBlock("b1", 1, 1)], attempts: 0 })
    const ctx = fakeCtx(
      storage,
      () => Promise.reject(new Error("不应该调用模型")),
      () => Promise.resolve(),
    )
    const event: CompactionEvent = {
      sessionID: "ses_only_checkpoint",
      model: { providerID: "fake", id: "model" },
      messages: [message("user", "<conversation-checkpoint>[T1] old</conversation-checkpoint>", "m0")],
    }

    await handleCompaction(ctx, event)

    const state = await loadState(storage, "ses_only_checkpoint")
    expect(state.blocks).toHaveLength(1)
    expect(state.pending).toBeUndefined()
    expect(event.result?.summary).toContain("#b1")
  })

  it("合并失败时保留 phase 等下一次重试", async () => {
    const storage = memoryStorage()
    await storage.set("settings", {
      models: { test: { contextLimit: 50_000 }, model: { contextLimit: 50_000 } },
      triggerPercent: 60,
      summaryBlockPercent: 20,
      summaryTotalPercent: 1,
      summaryFormat: "json",
    })
    await saveState(storage, "ses_retry_t3", {
      blocks: [longBlock("b1", 2, 1), longBlock("b2", 2, 2)],
      attempts: 0,
      phase: 2,
    })
    const ctx = fakeCtx(
      storage,
      () => Promise.reject(new Error("boom")),
      () => Promise.resolve(),
    )
    const event: CompactionEvent = {
      sessionID: "ses_retry_t3",
      model: { providerID: "fake", id: "model" },
      messages: [message("user", "<conversation-checkpoint>[T2] old</conversation-checkpoint>", "m0")],
    }

    await expect(handleCompaction(ctx, event)).rejects.toThrow("boom")

    const state = await loadState(storage, "ses_retry_t3")
    expect(state.phase).toBe(2)
    expect(state.lastError).toContain("boom")
  })

  it("T3 没有同层伙伴时自压，层数仍封顶 3", async () => {
    const storage = memoryStorage()
    await storage.set("settings", {
      models: { test: { contextLimit: 50_000 }, model: { contextLimit: 50_000 } },
      triggerPercent: 60,
      summaryBlockPercent: 20,
      summaryTotalPercent: 1,
      summaryFormat: "json",
    })
    await saveState(storage, "ses_t3_ceiling", {
      blocks: [longBlock("b1", 3, 1), longBlock("b2", 1, 2)],
      attempts: 0,
      phase: 3,
    })
    const ctx = fakeCtx(
      storage,
      () =>
        Promise.resolve({
          text: JSON.stringify({ candidate: 1, ...summary, facts: ["x".repeat(4_000)] }),
        }),
      () => Promise.resolve(),
    )
    const event: CompactionEvent = {
      sessionID: "ses_t3_ceiling",
      model: { providerID: "fake", id: "model" },
      messages: [message("user", "<conversation-checkpoint>[T3] old</conversation-checkpoint>", "m0")],
    }

    await handleCompaction(ctx, event)

    const state = await loadState(storage, "ses_t3_ceiling")
    // T3 段只有一个块：自压路径，产物层仍是 3（封顶），深度 +1。
    expect(state.pending?.tier).toBe(3)
    expect(state.pending?.sourceBlockIds).toEqual(["b1"])
    expect(state.pending?.height).toBe(4)
    // 摘要仍然超预算：留 phase 等下一轮继续压。
    expect(state.phase).toBe(2)
    expect(state.blocks).toHaveLength(2)
  })

  it("两个实例同时处理同一 compaction 只生成一次摘要", async () => {
    const storage = memoryStorage()
    await storage.set("settings", {
      models: { test: { contextLimit: 50_000 }, model: { contextLimit: 50_000 } },
      triggerPercent: 60,
      summaryBlockPercent: 20,
      summaryTotalPercent: 1,
      summaryFormat: "json",
    })
    await saveState(storage, "ses_parallel_compaction", {
      blocks: [longBlock("b1", 1, 1), longBlock("b2", 1, 2), longBlock("b3", 1, 3)],
      attempts: 0,
      phase: 2,
    })
    let calls = 0
    const ctx = fakeCtx(
      storage,
      () => {
        calls += 1
        return Promise.resolve({ text: JSON.stringify({ candidate: 1, ...summary }) })
      },
      () => Promise.resolve(),
    )
    const makeEvent = (): CompactionEvent => ({
      sessionID: "ses_parallel_compaction",
      model: { providerID: "fake", id: "model" },
      messages: [
        message("user", "<conversation-checkpoint>[T1] old</conversation-checkpoint>", "m0"),
        message("user", "continue", "m1"),
        message("assistant", "ok", "m2"),
      ],
    })

    await Promise.all([handleCompaction(ctx, makeEvent()), handleCompaction(ctx, makeEvent())])
    expect(calls).toBe(1)
  })

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
      state: { blocks: [block], attempts: 0 },
      pending: { ...block, id: "b2", order: 2 },
      budgetTokens: 50_000,
      recentT1Blocks: 0,
    })
    expect(result.merged).toBe(false)
    expect(result.pending?.id).toBe("b2")
    expect(calls).toBe(0)
  })

  it("超预算时只合并模型给定的前缀", async () => {
    let calls = 0
    const ctx = fakeCtx(
      memoryStorage(),
      () => {
        calls += 1
        return Promise.resolve({ text: JSON.stringify({ candidate: 2, ...summary }) })
      },
      () => Promise.resolve(),
    )
    const result = await distillOnce({
      ctx,
      sessionID: "ses_test",
      state: { blocks: [longBlock("b1", 1, 1)], attempts: 0 },
      pending: longBlock("b2", 1, 2),
      budgetTokens: 5_000,
      recentT1Blocks: 0,
    })
    expect(calls).toBe(1)
    expect(result.merged).toBe(true)
    expect(result.pending?.tier).toBe(2)
    expect(result.pending?.sourceBlockIds).toEqual(["b1", "b2"])
    expect(result.pending?.sourceTokens).toBe(2_000)
    expect(result.pending?.order).toBe(1)
    expect(activeBlocks(result.blocks, result.pending).map((item) => item.id)).toEqual([result.pending?.id])
  })

  it("模型给出越界 candidate 时整轮判失败，状态不动", async () => {
    let calls = 0
    const ctx = fakeCtx(
      memoryStorage(),
      () => {
        calls += 1
        // 组里只有 2 个块，模型却说要合 5 个。
        return Promise.resolve({ text: JSON.stringify({ candidate: 5, ...summary }) })
      },
      () => Promise.resolve(),
    )
    await expect(
      distillOnce({
        ctx,
        sessionID: "ses_test",
        state: { blocks: [longBlock("b1", 1, 1)], attempts: 0 },
        pending: longBlock("b2", 1, 2),
        budgetTokens: 5_000,
        recentT1Blocks: 0,
      }),
    ).rejects.toThrow("outside 1..2")
    expect(calls).toBe(3)
  })

  it("多候选时模型一次返回 candidate 和摘要", async () => {
    let calls = 0
    const ctx = fakeCtx(
      memoryStorage(),
      () => {
        calls += 1
        return Promise.resolve({ text: JSON.stringify({ candidate: 2, ...summary }) })
      },
      () => Promise.resolve(),
    )
    const result = await distillOnce({
      ctx,
      sessionID: "ses_test",
      state: {
        blocks: [longBlock("b1", 2, 1), tierBlock("b2", 2, 2), tierBlock("b3", 1, 3)],
        attempts: 0,
      },
      pending: tierBlock("b4", 1, 4),
      budgetTokens: 5_000,
      recentT1Blocks: 0,
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

  it("合并后还超预算时排下一轮合并", async () => {
    const ctx = fakeCtx(
      memoryStorage(),
      () => Promise.resolve({ text: JSON.stringify({ candidate: 2, ...summary }) }),
      () => Promise.resolve(),
    )
    const result = await distillOnce({
      ctx,
      sessionID: "ses_test",
      state: {
        blocks: [longBlock("b1", 2, 1), tierBlock("b2", 2, 2), longBlock("b3", 1, 3)],
        attempts: 0,
      },
      pending: tierBlock("b4", 1, 4),
      budgetTokens: 5_000,
      recentT1Blocks: 0,
    })
    expect(result.merged).toBe(true)
    expect(result.nextPhase).toBe(2)
  })

  it("T3 整段合完仍封顶 T3，压进预算后清 phase", async () => {
    const ctx = fakeCtx(
      memoryStorage(),
      () => Promise.resolve({ text: JSON.stringify({ candidate: 3, ...summary }) }),
      () => Promise.resolve(),
    )
    const result = await distillOnce({
      ctx,
      sessionID: "ses_test",
      state: {
        blocks: [longBlock("b1", 3, 1), longBlock("b2", 3, 2), longBlock("b3", 3, 3)],
        attempts: 0,
      },
      pending: undefined,
      budgetTokens: 5_000,
      recentT1Blocks: 0,
    })
    expect(result.merged).toBe(true)
    // 封顶：三个 T3 合成一个 T3，不是 T4。
    expect(result.pending?.tier).toBe(3)
    expect(result.pending?.sourceBlockIds).toEqual(["b1", "b2", "b3"])
    expect(result.pending?.height).toBe(4)
    expect(result.nextPhase).toBeUndefined()
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
        state: { blocks: [longBlock("b1", 1, 1)], attempts: 0 },
        pending: longBlock("b2", 1, 2),
        budgetTokens: 5_000,
        recentT1Blocks: 0,
      }),
    ).rejects.toThrow("not valid JSON")
  })

  it("总字符超限但 token 未超时不合并", async () => {
    const ctx = fakeCtx(
      memoryStorage(),
      () => Promise.resolve({ text: JSON.stringify({ candidate: 1, ...summary }) }),
      () => Promise.resolve(),
    )
    const result = await distillOnce({
      ctx,
      sessionID: "ses_test",
      state: { blocks: [tierBlock("b1", 1, 1), tierBlock("b2", 1, 2)], attempts: 0 },
      pending: undefined,
      // token 预算很大：字符口径不再参与判定，这是之前「疯狂压缩」的根因之一。
      budgetTokens: 999_999,
      summaryTotalChars: 10,
      summaryBlockChars: 20_000,
      recentT1Blocks: 0,
    })
    expect(result.merged).toBe(false)
  })

  it("candidate 0 判失败，不再夹到 1", async () => {
    const ctx = fakeCtx(
      memoryStorage(),
      () => Promise.resolve({ text: JSON.stringify({ candidate: 0, ...summary }) }),
      () => Promise.resolve(),
    )
    await expect(
      distillOnce({
        ctx,
        sessionID: "ses_test",
        state: { blocks: [longBlock("b1", 1, 1)], attempts: 0 },
        pending: longBlock("b2", 1, 2),
        budgetTokens: 5_000,
        recentT1Blocks: 0,
      }),
    ).rejects.toThrow("outside 1..2")
  })

  it("连环合并到轮数上限就停，不会无限压缩", async () => {
    const ctx = fakeCtx(
      memoryStorage(),
      () => Promise.resolve({ text: JSON.stringify({ candidate: 1, ...summary }) }),
      () => Promise.resolve(),
    )
    const result = await distillOnce({
      ctx,
      sessionID: "ses_test",
      state: { blocks: [longBlock("b1", 1, 1), longBlock("b2", 1, 2)], attempts: 0 },
      pending: undefined,
      budgetTokens: 5_000,
      recentT1Blocks: 0,
      distillRounds: MAX_DISTILL_ROUNDS - 1,
    })
    expect(result.merged).toBe(true)
    expect(result.distillRounds).toBe(MAX_DISTILL_ROUNDS)
    // 到了上限就不再排下一刀，避免"怎么合都压不进预算"时连环跑飞。
    expect(result.nextPhase).toBeUndefined()
  })

  it("普通合并会把连续轮数 +1", async () => {
    const ctx = fakeCtx(
      memoryStorage(),
      () => Promise.resolve({ text: JSON.stringify({ candidate: 2, ...summary }) }),
      () => Promise.resolve(),
    )
    const result = await distillOnce({
      ctx,
      sessionID: "ses_test",
      state: { blocks: [longBlock("b1", 1, 1)], attempts: 0 },
      pending: longBlock("b2", 1, 2),
      budgetTokens: 5_000,
      recentT1Blocks: 0,
    })
    expect(result.merged).toBe(true)
    expect(result.distillRounds).toBe(1)
  })

  it("越界编号判失败，不改用最后一个候选", async () => {
    const ctx = fakeCtx(
      memoryStorage(),
      () => Promise.resolve({ text: JSON.stringify({ candidate: 99, ...summary }) }),
      () => Promise.resolve(),
    )
    await expect(
      distillOnce({
        ctx,
        sessionID: "ses_test",
        state: { blocks: [longBlock("b1", 1, 1)], attempts: 0 },
        pending: longBlock("b2", 1, 2),
        budgetTokens: 5_000,
        recentT1Blocks: 0,
      }),
    ).rejects.toThrow("outside 1..2")
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
        state: { blocks: [longBlock("b1", 1, 1)], attempts: 0 },
        pending: longBlock("b2", 1, 2),
        budgetTokens: 5_000,
        recentT1Blocks: 0,
      }),
    ).rejects.toThrow("empty field: goal")
  })

  it("T2 合并成 T3 后只剩一块时 phase 清空", async () => {
    const storage = memoryStorage()
    await storage.set("settings", {
      models: { test: { contextLimit: 50_000 }, model: { contextLimit: 50_000 } },
      triggerPercent: 60,
      summaryBlockPercent: 20,
      summaryTotalPercent: 1,
      summaryFormat: "json",
    })
    await saveState(storage, "ses_t2_chain", {
      blocks: [longBlock("b1", 2, 1), longBlock("b2", 2, 2)],
      attempts: 0,
      phase: 2,
    })
    const ctx = fakeCtx(
      storage,
      () => Promise.resolve({ text: JSON.stringify({ candidate: 2, ...summary }) }),
      () => Promise.resolve(),
    )
    const event: CompactionEvent = {
      sessionID: "ses_t2_chain",
      model: { providerID: "fake", id: "model" },
      messages: [message("user", "<conversation-checkpoint>[T2] old</conversation-checkpoint>", "m0")],
    }
    await handleCompaction(ctx, event)
    const state = await loadState(storage, "ses_t2_chain")
    // 两个 T2 合成一个 T3；链上只剩这一块，没有下一层可排。
    expect(state.pending?.tier).toBe(3)
    expect(state.phase).toBeUndefined()
  })
})

describe("多次压缩长跑", () => {
  /** 输入：状态；输出：active 顶层块，按 order 排。 */
  const activeOf = (state: State): readonly Block[] => activeBlocks(state.blocks, state.pending)

  /** 输入：轮次；输出：该轮的新对话流（含工具输出，撑出真实的 sourceTokens）。 */
  const roundMessages = (round: number): MessageLike[] => [
    message("user", `round ${round.toString()} question`, `u${round.toString()}`),
    {
      id: `a${round.toString()}`,
      role: "assistant",
      content: [
        { type: "text", text: `answer ${round.toString()}` },
        { type: "tool-result", name: "shell", result: `out-${round.toString()}-` + "x".repeat(4_000) },
      ],
    },
  ]

  it("反复压缩 40 轮：同层合并、区间连续、预算内清 phase、原文可解压", async () => {
    const storage = memoryStorage()
    await storage.set("settings", {
      // 窗口小、摘要预算小，逼出多层合并；模型总是要求合满整段。
      models: { test: { contextLimit: 50_000 }, model: { contextLimit: 50_000 } },
      triggerPercent: 60,
      summaryBlockPercent: 5,
      summaryTotalPercent: 10,
      summaryFormat: "json",
    })
    const ctx = fakeCtx(
      storage,
      () => Promise.resolve({ text: JSON.stringify({ candidate: 999, ...summary }) }),
      () => Promise.resolve(),
    )
    let nextMessageId = 0
    for (let round = 1; round <= 40; round += 1) {
      const messages = roundMessages(round).map((item) => {
        const id = item.id ?? "m"
        return { ...item, id: `${id}_${(nextMessageId += 1).toString()}` }
      })
      const event: CompactionEvent = {
        sessionID: "ses_soak",
        model: { providerID: "fake", id: "model" },
        messages,
      }
      // 压缩失败直接让测试炸出来，不允许吞错。
      await handleCompaction(ctx, event)

      const state = await loadState(storage, "ses_soak")
      const active = activeOf(state)

      // 不变量 2：active 链 tier 单调不增。
      for (let index = 1; index < active.length; index += 1) {
        const current = active[index]
        const previous = active[index - 1]
        expect(current !== undefined && previous !== undefined && current.tier <= previous.tier).toBe(true)
      }
      // 不变量 3：b 编号不重复。
      const ids = state.blocks.map((item) => item.id)
      expect(new Set(ids).size).toBe(ids.length)
      // 不变量 4：active 块的覆盖区间连续不重叠（按消息序）。
      const sorted = [...active].sort((a, b) => a.order - b.order)
      for (let index = 1; index < sorted.length; index += 1) {
        const current = sorted[index]
        const previous = sorted[index - 1]
        expect(
          current !== undefined &&
            previous !== undefined &&
            (current.fromId >= previous.toId || previous.toId === ""),
        ).toBe(true)
      }
      // 不变量 5：pending 有值时 phase 必须也有值（等事件转正）；转正后预算内必须无 phase。
      if (state.pending === undefined && state.phase !== undefined) {
        // phase 只在摘要超预算时允许残留；这里每轮压完都清，不允许挂着。
        const text = renderAll(state.blocks, undefined)
        expect(countText(text)).toBeLessThanOrEqual(50_000 * 0.1 + 1)
      }
      // 不变量 6：所有 T1 块都有转录，能解出原文。
      for (const block of state.blocks) {
        if (block.sourceBlockIds !== undefined && block.sourceBlockIds.length > 0) continue
        const manifest = await loadTranscriptManifest(storage, "ses_soak", block.id)
        expect(manifest).toBeDefined()
      }
    }

    // 终局：先把可能残留的 pending 转正，再从 active 链第一个块解压回原文。
    const final = await loadState(storage, "ses_soak")
    const committed = commitPending(final)
    await saveState(storage, "ses_soak", committed)
    const chain = activeBlocks(committed.blocks, undefined)
    const first = chain[0]
    expect(first).toBeDefined()
    if (first === undefined) return
    const restored = await resolveDecompress(
      { block: first.id, full: true },
      { storage },
      "ses_soak",
      { inlineMax: 1_000_000, tempCap: 5, showTokens: false },
    )
    expect(restored.status).toBe("ok")
    if (restored.status === "ok") {
      expect(restored.inline).toContain("[User]")
    } else {
      throw new Error(`decompress failed: ${restored.message}`)
    }
  })

  it("反复压缩 20 轮：事件对账把 pending 逐轮转正，状态不堆积", async () => {
    const storage = memoryStorage()
    await storage.set("settings", {
      models: { test: { contextLimit: 50_000 }, model: { contextLimit: 50_000 } },
      triggerPercent: 60,
      summaryBlockPercent: 5,
      summaryTotalPercent: 10,
      summaryFormat: "json",
    })
    const ctx = fakeCtx(
      storage,
      () => Promise.resolve({ text: JSON.stringify({ candidate: 1, ...summary }) }),
      () => Promise.resolve(),
    )
    // 事件对账用独立 ctx：session.context 返回当前整条摘要链，pending marker 一定在里面。
    const eventCtx = (): Plugin.Context =>
      ({
        storage,
        session: {
          context: () =>
            Promise.resolve([
              {
                type: "compaction",
                status: "completed",
                summary: markers.join("\n"),
              },
            ]),
          compact: () => Promise.resolve(),
        },
      }) as unknown as Plugin.Context
    const markers: string[] = []
    let nextMessageId = 0
    for (let round = 1; round <= 20; round += 1) {
      const messages = roundMessages(round).map((item) => {
        const id = item.id ?? "m"
        return { ...item, id: `${id}_${(nextMessageId += 1).toString()}` }
      })
      const event: CompactionEvent = {
        sessionID: "ses_commit",
        model: { providerID: "fake", id: "model" },
        messages,
      }
      await handleCompaction(ctx, event)

      // 真实流程：压缩结束后宿主发 session.compaction.ended，插件对账转正。
      // 对账只认「最新 checkpoint 包含 pending marker」，所以维护一份 marker 集合。
      const mid = await loadState(storage, "ses_commit")
      for (const item of mid.blocks) markers.push(blockMarker(item.id))
      if (mid.pending !== undefined) markers.push(blockMarker(mid.pending.id))
      await handleCompactionEvent(eventCtx(), "ended", "ses_commit")

      const state = await loadState(storage, "ses_commit")
      // 每轮结束都不许有残留 pending：事件对账必须吃掉它。
      expect(state.pending).toBeUndefined()
      // 转正后 attempts 归零，下一轮不会因为旧失败计数被挡。
      expect(state.attempts).toBe(0)
    }
    // 终局：块全在 storage 里，数量随轮次单调增长，没有块被悄悄丢掉。
    const final = await loadState(storage, "ses_commit")
    expect(final.blocks.length).toBeGreaterThanOrEqual(20)
    const ids = final.blocks.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
