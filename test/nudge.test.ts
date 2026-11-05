import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Schema } from "effect"
import type { Plugin } from "@opencode/plugin"
import { describe, expect, it } from "vitest"

import { buildNudgeText, maybeNudge } from "../src/compression/auto.ts"
import { DEFAULT_SERVER_SETTINGS, loadServerSettings } from "../src/compression/settings.ts"
import { loadState, saveState, type Block, type StorageLike } from "../src/compression/state.ts"
import type { MessageLike } from "../src/compression/select.ts"
import { CONFIG_FILE } from "../src/shared/config-paths.ts"
import type { TokenCategories } from "../src/shared/tokens.ts"

/** 测试里只作为 JSONC 的旧键名，插件本身不再读 storage 设置。 */
const SETTINGS_KEY = "settings"
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

/** 输入：文本；输出：一段带前序消息和当前 user 的上下文。 */
function context(text: string): MessageLike[] {
  return [
    { id: "m0", role: "user", content: [{ type: "text", text: "start" }] },
    { id: "m1", role: "assistant", content: [{ type: "text", text }] },
    { id: "m2", role: "user", content: [{ type: "text", text: "continue" }] },
  ]
}

/** 输入：storage；输出：只提供 storage + 临时配置目录的假 ctx。 */
function fakeCtx(storage: StorageLike): Plugin.Context {
  return {
    storage,
    location: { directory: configDirectories.get(storage) ?? tmpdir() },
    // isSubagentSession 是 fail-closed：session.get 缺失会被当成子代理跳过 nudge。
    // 默认提供「无 parentID」的会话，子代理用例单独覆盖。
    session: {
      get: () => Promise.resolve({ location: { directory: configDirectories.get(storage) ?? tmpdir() } }),
    },
  } as unknown as Plugin.Context
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
  /** 输入：可选分类覆盖；输出：完整的分类估算；预期：默认全 0，便于只断言关心的字段。 */
  const categories = (overrides: Partial<TokenCategories> = {}): TokenCategories => ({
    system: 0,
    tools: 0,
    tool: 0,
    text: 0,
    recent: 0,
    summaries: 0,
    media: 0,
    ...overrides,
  })

  it("增长量显示自上次压缩块（或会话起始）以来的累计增量", () => {
    const textCompressed = buildNudgeText({
      growthTokens: 52_300,
      categories: categories(),
      hasCompressed: true,
      autoCompress: true,
      format: "babel",
    })
    expect(textCompressed).toContain("Content has grown by about 52k tokens since the last compressed block")
    expect(textCompressed).toContain("entire current conversation flow since the last compressed block")

    const textUncompressed = buildNudgeText({
      growthTokens: 52_300,
      categories: categories(),
      hasCompressed: false,
      autoCompress: true,
      format: "babel",
    })
    expect(textUncompressed).toContain("Content has grown by about 52k tokens since the session started")
    expect(textUncompressed).toContain("entire current conversation flow since the session started")

    // 明确先劝住：忙或还需要精确细节时不要压缩。
    expect(textCompressed).toContain("If you are busy or still need these exact details, keep working and ignore this reminder")
    expect(textCompressed).toContain("When you reach a natural stopping point")
    expect(textCompressed).toContain("carrying forward still-open objectives")
    expect(textCompressed).toContain("Automatic compression will run later")
  })

  it("提醒里带上按类别的上下文构成，只列非零项", () => {
    const text = buildNudgeText({
      growthTokens: 51_000,
      categories: categories({ system: 12_000, tools: 5_300, tool: 45_200, text: 15_100, summaries: 38_000, media: 1_500 }),
      hasCompressed: true,
      autoCompress: true,
      format: "babel",
    })
    expect(text).toContain(
      "Context: 12k system | 5.3k tools | 45k tool | 15k text | 1.5k media | 38k summaries.",
    )
    // recent 不参与构成行：它不是可压缩的新增内容。
    expect(text).not.toContain("recent")
  })

  it("Babel 提醒带正反例铁律，禁止括号里写整句", () => {
    const text = buildNudgeText({
      growthTokens: 51_000,
      categories: categories({ tool: 45_200 }),
      hasCompressed: true,
      autoCompress: true,
      format: "babel",
    })
    expect(text).toContain("BABEL FORMAT LOCK (zero prose)")
    expect(text).toContain("T=<title>|G=<goal>")
    expect(text).toContain("❌ D[db]: 因为并发高所以换成了 LMDB")
    expect(text).toContain("✅ D[db]: concurrency_lock => LMDB & perf_up")
    expect(text).toContain("⏳[target]")
    // 不同格式的规则不会串台。
    expect(text).not.toContain("SUMMARY FORMAT (JSON")
  })

  it("Markdown 与 JSON 提醒各自只带对应格式的规则", () => {
    const markdown = buildNudgeText({
      growthTokens: 51_000,
      categories: categories({ text: 20_000 }),
      hasCompressed: true,
      autoCompress: true,
      format: "markdown",
    })
    expect(markdown).toContain("SUMMARY FORMAT (dense facts, zero narrative)")
    expect(markdown).toContain("Open objectives")
    expect(markdown).not.toContain("BABEL FORMAT LOCK")

    const json = buildNudgeText({
      growthTokens: 51_000,
      categories: categories({ text: 20_000 }),
      hasCompressed: true,
      autoCompress: true,
      format: "json",
    })
    expect(json).toContain("SUMMARY FORMAT (JSON, zero commentary)")
    expect(json).toContain("progress{completed,active,blocked}")
    expect(json).not.toContain("BABEL FORMAT LOCK")
  })

  it("多次连续提醒时累积显示增长量（50k -> 100k -> 150k 形态）", async () => {
    // 阈值 1_000 tokens（约 4_000 字符）
    const storage = memoryStorage({ [SETTINGS_KEY]: settings(1_000) })
    const messages = context("x".repeat(4_000))

    // 1. 建立初始基线（无提醒追加）
    await maybeNudge(input(storage, messages))
    expect(messages).toHaveLength(3)

    // 2. 增长约 2_000 tokens，触发第 1 次提醒（报 2.0k）
    messages[1] = { id: "m1", role: "assistant", content: [{ type: "text", text: "x".repeat(12_000) }] }
    await maybeNudge(input(storage, messages))
    expect(messages).toHaveLength(4)
    expect(messages[3]?.content[0]?.text).toContain("about 2.0k tokens since the session started")
    expect((await loadState(storage, "ses_test")).nudgeCount).toBe(1)

    // 清理掉追加的单条 notice，模拟进入下一轮
    messages.pop()

    // 3. 再增长约 2_000 tokens（累计增长约 4_000 tokens），触发第 2 次提醒（报 4.0k 累积，而非依然报 2.0k）
    messages[1] = { id: "m1", role: "assistant", content: [{ type: "text", text: "x".repeat(20_000) }] }
    await maybeNudge(input(storage, messages))
    expect(messages).toHaveLength(4)
    expect(messages[3]?.content[0]?.text).toContain("about 4.0k tokens since the session started")
    expect((await loadState(storage, "ses_test")).nudgeCount).toBe(2)
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

  it("compress 工具关闭时跳过提醒，且不改用户设置", async () => {
    const storage = memoryStorage({
      [SETTINGS_KEY]: { ...settings(1_000), enableCompressTool: false },
    })
    const messages = context("x".repeat(20_000))
    await maybeNudge(input(storage, messages))
    expect(messages).toHaveLength(3)
    const state = await loadState(storage, "ses_test")
    expect(state.nudgeBaselineTokens).toBeUndefined()
    expect(state.nudgeCount ?? 0).toBe(0)

    // 只跳过运行时提醒，不替用户关提醒、也不改工具开关。
    const stored = await loadServerSettings(fakeCtx(storage))
    expect(stored.nudgeGrowthTokens).toBe(1_000)
    expect(stored.enableCompressTool).toBe(false)
  })

  it("压缩 pending 时跳过提醒", async () => {
    const pending: Block = {
      id: "b1",
      tier: 1,
      height: 1,
      summary: { format: "markdown", title: "old", text: "old" },
      fromId: "m0",
      toId: "m0",
      sourceTokens: 10,
      summaryTokens: 1,
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
    expect(
      buildNudgeText({
        growthTokens: 10_000,
        categories: categories(),
        hasCompressed: false,
        autoCompress: false,
        format: "babel",
      }),
    ).toContain("Call compress when convenient")
  })

  it("子代理会话不追加提醒", async () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: settings(1_000) })
    // 覆盖 session.get：返回带 parentID 的会话，命中子代理守卫。
    const ctx = fakeCtx(storage) as unknown as {
      session: { get: () => Promise<{ parentID: string; location: { directory: string } }> }
    }
    ctx.session.get = () =>
      Promise.resolve({ parentID: "ses_parent", location: { directory: tmpdir() } })
    const messages = context("x".repeat(20_000))
    await maybeNudge(input(storage, messages))
    expect(messages).toHaveLength(3)
  })

  it("已排下一层蒸馏时跳过提醒", async () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: settings(1_000) })
    await saveState(storage, "ses_test", { blocks: [], attempts: 0, phase: 2 })
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

  it("系统提示词、摘要块和最近保留区膨胀都不算增长", async () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: settings(1_000) })
    const messages = context("x".repeat(24_000))

    // 建立基线：此时内容量约 6k（原文够长，才有可压缩内容）。
    const first = { ...input(storage, messages), system: [{ type: "text", text: "s".repeat(8_000) }] }
    await maybeNudge(first)
    expect(messages).toHaveLength(3)
    const baseline = (await loadState(storage, "ses_test")).nudgeBaselineTokens
    expect(baseline).toBeGreaterThan(0)

    // 只有系统提示词涨了 20k 字符（约 5k tokens）：不是对话内容，不该提醒。
    const grownSystem = { ...input(storage, messages), system: [{ type: "text", text: "s".repeat(28_000) }] }
    await maybeNudge(grownSystem)
    expect(messages).toHaveLength(3)

    // 新增一大段摘要块与最近保留区：都是已压缩/法定保留，不该提醒。
    messages.push({
      id: "m3",
      role: "user",
      content: [
        {
          type: "text",
          text:
            "<conversation-checkpoint>\n" +
            `<summary>${"a".repeat(40_000)}</summary>\n` +
            `<recent-context>${"b".repeat(40_000)}</recent-context>\n` +
            "</conversation-checkpoint>",
        },
      ],
    })
    await maybeNudge(input(storage, messages))
    expect(messages).toHaveLength(4)
    expect((await loadState(storage, "ses_test")).nudgeCount ?? 0).toBe(0)

    // 真正新增工具结果时才提醒：8k 字符约 2k tokens，超过 1k 阈值。
    messages.push({
      id: "m4",
      role: "assistant",
      content: [{ type: "tool-result", name: "read", result: { type: "text", value: "r".repeat(8_000) } }],
    })
    await maybeNudge(input(storage, messages))
    expect(messages).toHaveLength(6)
    expect(messages[5]?.content[0]?.text).toContain("about 2.0k tokens since the session started")
    expect((await loadState(storage, "ses_test")).nudgeCount).toBe(1)
  })

  it("多模态媒体占用计入增长量", async () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: settings(1_000) })
    const messages = context("x".repeat(24_000))
    // 先建立基线（图片尚未出现）。
    await maybeNudge(input(storage, messages))
    expect(messages).toHaveLength(3)

    // 一张无尺寸信息的图片按 1500 tokens 计，超过 1k 阈值。
    messages.push({
      id: "m3",
      role: "user",
      content: [{ type: "media", media: { source: { type: "base64", mediaType: "image/png" } } }],
    })
    await maybeNudge(input(storage, messages))
    expect(messages).toHaveLength(5)
    expect(messages[4]?.content[0]?.text).toContain("about 1.5k tokens since the session started")
  })

  it("工具定义变多也计入增长量", async () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: settings(1_000) })
    const messages = context("x".repeat(24_000))
    await maybeNudge(input(storage, messages))
    expect(messages).toHaveLength(3)

    // 新挂载一个描述很长的工具（8k 字符约 2k tokens），属于真正新增的请求内容。
    const withTools = {
      ...input(storage, messages),
      tools: { big: { description: "d".repeat(8_000), input: {} } },
    }
    await maybeNudge(withTools)
    expect(messages).toHaveLength(4)
    expect((await loadState(storage, "ses_test")).nudgeCount).toBe(1)
  })
})

