import type { Schema } from "effect"
import type { Plugin } from "@opencode/plugin"
import { describe, expect, it } from "vitest"

import { buildNudgeText, maybeNudge } from "../src/compression/auto.ts"
import { DEFAULT_SERVER_SETTINGS, SETTINGS_KEY } from "../src/compression/settings.ts"
import { loadState, saveState, MAX_COMPRESSION_ATTEMPTS, type Block, type StorageLike } from "../src/compression/state.ts"
import type { MessageLike } from "../src/compression/select.ts"

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

/** 输入：文本；输出：一段带前序消息和当前 user 的上下文。 */
function context(text: string): MessageLike[] {
  return [
    { id: "m0", role: "user", content: [{ type: "text", text: "start" }] },
    { id: "m1", role: "assistant", content: [{ type: "text", text }] },
    { id: "m2", role: "user", content: [{ type: "text", text: "continue" }] },
  ]
}

/** 输入：storage；输出：只提供 storage 的假 ctx。 */
function fakeCtx(storage: StorageLike): Plugin.Context {
  return { storage } as unknown as Plugin.Context
}

/** 输入：storage + 可追加消息；输出：执行 maybeNudge 所需的输入。 */
function input(storage: StorageLike, messages: MessageLike[]) {
  return {
    ctx: fakeCtx(storage),
    sessionID: "ses_test",
    messages,
    system: [],
    tools: {},
    model: { providerID: "test", id: "test" },
  }
}

const settings = (nudgeGrowthTokens: number, autoCompress = true) => ({
  ...DEFAULT_SERVER_SETTINGS,
  nudgeGrowthTokens,
  autoCompress,
})

describe("主动压缩提醒", () => {
  it("文案使用实际增长量，并说明范围是整段当前对话流", () => {
    const text = buildNudgeText(52_300, true, true)
    expect(text).toContain("about 52k tokens since the last compressed block")
    expect(text).toContain("entire current conversation flow since the last compressed block")
    expect(text).toContain("automatic compression will run later")
  })

  it("第一次只建立基线，增长到阈值后才追加一次提醒", async () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: settings(1_000) })
    const messages = context("x".repeat(4_000))
    await maybeNudge(input(storage, messages))
    expect(messages).toHaveLength(3)
    expect((await loadState(storage, "ses_test")).nudgeBaselineTokens).toBeGreaterThan(0)

    messages[1] = { id: "m1", role: "assistant", content: [{ type: "text", text: "x".repeat(12_000) }] }
    await maybeNudge(input(storage, messages))
    expect(messages).toHaveLength(4)
    expect(messages[3]?.content[0]?.text).toContain("entire current conversation flow")
    const state = await loadState(storage, "ses_test")
    expect(state.nudgeCount).toBe(1)

    await maybeNudge(input(storage, messages))
    expect(messages).toHaveLength(4)
  })

  it("nudgeGrowthTokens=0 时不建立基线、不追加提醒", async () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: settings(0) })
    const messages = context("x".repeat(20_000))
    await maybeNudge(input(storage, messages))
    expect(messages).toHaveLength(3)
    expect((await loadState(storage, "ses_test")).nudgeBaselineTokens).toBeUndefined()
  })

  it("压缩 pending 时跳过提醒", async () => {
    const pending: Block = {
      id: "b1",
      tier: 1,
      summary: { format: "markdown", title: "old", text: "old" },
      fromId: "m0",
      toId: "m0",
      tokensBefore: 10,
      tokensAfter: 1,
      at: 1,
      order: 1,
    }
    const storage = memoryStorage({ [SETTINGS_KEY]: settings(1_000) })
    await saveState(storage, "ses_test", { blocks: [], attempts: 0, pending })
    const messages = context("x".repeat(20_000))
    await maybeNudge(input(storage, messages))
    expect(messages).toHaveLength(3)
  })

  it("自动压缩关闭时文案改为手动调用", () => {
    expect(buildNudgeText(10_000, false, false)).toContain("call compress when convenient")
  })

  it("终止态下不追加提醒", async () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: settings(1_000) })
    await saveState(storage, "ses_test", { blocks: [], attempts: 0, terminal: "no candidate" })
    const messages = context("x".repeat(20_000))
    await maybeNudge(input(storage, messages))
    expect(messages).toHaveLength(3)
  })

  it("尝试次数达上限后不追加提醒", async () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: settings(1_000) })
    await saveState(storage, "ses_test", { blocks: [], attempts: MAX_COMPRESSION_ATTEMPTS })
    const messages = context("x".repeat(20_000))
    await maybeNudge(input(storage, messages))
    expect(messages).toHaveLength(3)
  })

  it("已排下一层蒸馏时跳过提醒", async () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: settings(1_000) })
    await saveState(storage, "ses_test", { blocks: [], attempts: 0, phase: "t2" })
    const messages = context("x".repeat(20_000))
    await maybeNudge(input(storage, messages))
    expect(messages).toHaveLength(3)
  })

  it("最后一条 user 是插件自己的压缩指令时跳过", async () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: settings(1_000) })
    const messages: MessageLike[] = [
      { id: "m0", role: "assistant", content: [{ type: "text", text: "x".repeat(20_000) }] },
      { id: "m1", role: "user", content: [{ type: "text", text: "You are writing a checkpoint for this session" }] },
    ]
    await maybeNudge(input(storage, messages))
    expect(messages).toHaveLength(2)
  })

  it("上下文总量下降时重置基线且不追加", async () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: settings(1_000) })
    const big = context("x".repeat(40_000))
    await maybeNudge(input(storage, big))
    const baseline = (await loadState(storage, "ses_test")).nudgeBaselineTokens
    expect(baseline).toBeGreaterThan(0)

    const small = context("x")
    await maybeNudge(input(storage, small))
    expect(small).toHaveLength(3)
    const state = await loadState(storage, "ses_test")
    expect(state.nudgeBaselineTokens).toBeLessThan(baseline ?? 0)
    expect(state.nudgeCount ?? 0).toBe(0)
  })

  it("上下文没增长时即使已跨过一次阈值也不再追加", async () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: settings(1_000) })
    const messages = context("x".repeat(8_000))
    await maybeNudge(input(storage, messages))
    const baseline = (await loadState(storage, "ses_test")).nudgeBaselineTokens

    messages[1] = { id: "m1", role: "assistant", content: [{ type: "text", text: "x".repeat(12_000) }] }
    await maybeNudge(input(storage, messages))
    expect(messages).toHaveLength(4)

    await maybeNudge(input(storage, messages))
    expect(messages).toHaveLength(4)
    expect((await loadState(storage, "ses_test")).nudgeBaselineTokens).toBeGreaterThan(baseline ?? 0)
  })
})
