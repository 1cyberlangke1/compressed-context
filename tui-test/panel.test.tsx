import { testRender } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"

import type { SummaryBlock } from "../src/blocks.ts"
import type { CacheSample } from "../src/cache.ts"
import { DEFAULT_SETTINGS, type Settings } from "../src/settings.ts"
import { Panel } from "../src/tui/panel.tsx"

/** 输入：无；输出：Panel 需要的最小主题。 */
function fakeTheme(): Context["theme"] {
  return {
    text: {
      base: "#ffffff",
      muted: "#888888",
      feedback: {
        success: { base: "#00ff00" },
        warning: { base: "#ffff00" },
        error: { base: "#ff0000" },
        info: { base: "#00aaff" },
      },
    },
    background: { raised: { high: "#222222" } },
  } as unknown as Context["theme"]
}

/** 输入：无；输出：10 条带 usage 的 assistant 消息。 */
function fakeMessages() {
  return Array.from({ length: 10 }, (_, index) => ({
    type: "assistant",
    id: `m${index.toString()}`,
    model: { providerID: "fake", id: "model" },
    tokens: {
      input: 100,
      output: 10,
      reasoning: 0,
      cache: { read: 90 - index, write: 0 },
    },
  }))
}

/** 输入：无；输出：10 条缓存样本，命中率 20..100。 */
function fakeSamples(): CacheSample[] {
  return Array.from({ length: 10 }, (_, index) => ({
    messageID: `m${index.toString()}`,
    at: index,
    input: 100,
    output: 10,
    cached: 10 + index * 10,
    hitRate: 10 + index * 10,
  }))
}

/** 输入：无；输出：一个 T1 和一个 T2 块。 */
function fakeBlocks(): SummaryBlock[] {
  return [
    {
      id: "b1",
      tier: 1,
      title: "first",
      at: 1,
      tokensBefore: 100,
      tokensAfter: 10,
      body: "## Goal\n\nBODY_MARKER",
    },
    {
      id: "b2",
      tier: 2,
      title: "merged",
      at: 2,
      tokensBefore: 20,
      tokensAfter: 5,
      sourceBlockIds: ["b1"],
      body: "## Goal\n\nMERGED_MARKER",
    },
  ]
}

/** 输入：无；输出：Panel 需要的最小上下文。 */
function fakeContext(): Context {
  const samples = fakeSamples()
  const blocks = fakeBlocks()
  return {
    theme: fakeTheme(),
    data: {
      session: {
        get: () => ({ location: {} }),
        message: { list: () => fakeMessages() },
      },
      location: { model: { list: () => [{ providerID: "fake", id: "model", limit: { context: 200_000 } }] } },
      on: () => () => {},
    },
    client: {
      session: {
        get: () =>
          Promise.resolve({
            metadata: {
              "compressed-context": {
                system: 100,
                tools: 50,
                tool: 30,
                text: 20,
                recent: 10,
                summaries: 5,
                media: 0,
                estimatedTotal: 215,
                at: 1,
              },
            },
          }),
      },
      rpc: () => ({
        cacheHistoryGet: () => Promise.resolve({ samples }),
        blocksGet: () => Promise.resolve({ blocks }),
      }),
    },
  } as unknown as Context
}

/** 输入：无；输出：带可写 settings 的 Panel 根组件。 */
function Fixture() {
  const [settings, setSettings] = createSignal<Settings>({
    ...DEFAULT_SETTINGS,
    showTimeline: true,
    showBlockTokens: true,
  })
  const updateSettings = async (mutation: (draft: Settings) => void): Promise<void> => {
    setSettings((previous) => {
      const draft = { ...previous }
      mutation(draft)
      return draft
    })
  }
  return (
    <Panel
      context={fakeContext()}
      sessionID="ses_a"
      settings={settings()}
      updateSettings={updateSettings}
    />
  )
}

/** 输入：app + 文本；输出：该文本所在行号；找不到返回 -1。 */
function rowOf(app: Awaited<ReturnType<typeof testRender>>, text: string): number {
  return app.captureCharFrame().split("\n").findIndex((line) => line.includes(text))
}

describe("Panel", () => {
  test("渲染缓存折线、日志和摘要块", async () => {
    const app = await testRender(() => <Fixture />, { width: 42, height: 80 })
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes("缓存记录"))
      expect(frame).toContain("上下文构成")
      expect(frame).toContain("折线图")
      expect(frame).toContain("100%")
      expect(frame).toContain("90%")
      expect(frame).toContain("0%")
      expect(frame).toContain("日志")
      expect(frame).toContain("输入")
      expect(frame).toContain("输出")
      expect(frame).toContain("缓存")
      expect(frame).toContain("命中")
      expect(frame).toContain("摘要块")
      expect(frame).toContain("b1: first")
      expect(frame).toContain("[T1]")
      expect(frame).toContain("≈10")
      expect(frame).toContain("merged #b1")
    } finally {
      app.renderer.destroy()
    }
  })

  test("点击折叠缓存区，再点击展开", async () => {
    const app = await testRender(() => <Fixture />, { width: 42, height: 80 })
    app.renderer.start()
    try {
      await app.waitForFrame((value) => value.includes("折线图"))
      await app.mockMouse.click(2, rowOf(app, "缓存记录"))
      await app.waitForFrame((value) => !value.includes("折线图"))
      await app.mockMouse.click(2, rowOf(app, "缓存记录"))
      await app.waitForFrame((value) => value.includes("折线图"))
    } finally {
      app.renderer.destroy()
    }
  })

  test("点击摘要块展开 markdown，再点击收起", async () => {
    const app = await testRender(() => <Fixture />, { width: 42, height: 80 })
    app.renderer.start()
    try {
      await app.waitForFrame((value) => value.includes("b1: first"))
      await app.mockMouse.click(2, rowOf(app, "b1: first"))
      await app.waitForFrame((value) => value.includes("BODY_MARKER"))
      await app.mockMouse.click(2, rowOf(app, "b1: first"))
      await app.waitForFrame((value) => !value.includes("BODY_MARKER"))
    } finally {
      app.renderer.destroy()
    }
  })
})
