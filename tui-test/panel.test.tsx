import { testRender } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"
import type { JSX } from "solid-js"

import type { SummaryBlock } from "../src/shared/blocks.ts"
import type { CacheSample } from "../src/shared/cache.ts"
import { DEFAULT_SETTINGS, type Settings } from "../src/shared/settings.ts"
import { Panel } from "../src/tui/panel/index.tsx"

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

/** 输入：最后一条输入的 token；输出：10 条带 usage 的 assistant 消息。 */
function fakeMessages(input = 100) {
  return Array.from({ length: 10 }, (_, index) => ({
    type: "assistant",
    id: `m${index.toString()}`,
    model: { providerID: "fake", id: "model" },
    tokens: {
      input,
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
      format: "markdown",
      title: "first",
      at: 1,
      sourceTokens: 100,
      summaryTokens: 10,
      body: "## Goal\n\nBODY_MARKER",
    },
    {
      id: "b2",
      tier: 2,
      format: "markdown",
      title: "merged",
      at: 2,
      sourceTokens: 20,
      summaryTokens: 5,
      sourceBlockIds: ["b1"],
      body: "## Goal\n\nMERGED_MARKER",
    },
  ]
}

let capturedDialog: (() => JSX.Element) | undefined

/** 输入：无；输出：Panel 需要的最小上下文。 */
function fakeContext(input = 100): Context {
  const samples = fakeSamples()
  const blocks = fakeBlocks()
  return {
    theme: fakeTheme(),
    renderer: { height: 40 },
    ui: {
      dialog: {
        show: (render: () => JSX.Element) => {
          capturedDialog = render
        },
        set: () => {},
        clear: () => {
          capturedDialog = undefined
        },
      },
    },
    data: {
      session: {
        get: () => ({ location: {} }),
        message: { list: () => fakeMessages(input) },
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

/** 输入：可选初始设置；输出：带可写 settings 的 Panel 根组件。 */
function Fixture(props: { readonly initial?: Partial<Settings>; readonly used?: number }) {
  const [settings, setSettings] = createSignal<Settings>({
    ...DEFAULT_SETTINGS,
    showTimeline: true,
    showBlockTokens: true,
    ...props.initial,
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
      context={fakeContext(props.used)}
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
    const app = await testRender(() => <Fixture initial={{ cacheLogExpanded: true }} />, {
      width: 42,
      height: 80,
    })
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes("缓存记录"))
      expect(frame).toContain("上下文构成")
      expect(frame).toContain("缓存记录 (100.00%)")
      expect(frame).toContain("摘要块 (2)")
      expect(frame).toContain("折线图")
      expect(frame).toContain("100%")
      expect(frame).toContain("90%")
      expect(frame).toContain("0%")
      expect(frame).toContain("日志")
      expect(frame).toContain("输入")
      expect(frame).toContain("输出")
      expect(frame).toContain("缓存")
      expect(frame).toContain("命中")
      expect(frame).toContain("摘要块 (2)")
      expect(frame).toContain("[T1] b1 : first")
      expect(frame).toContain("[T2] b2 : merged")
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

  test("hover 显示浮动箭头，移出后消失", async () => {
    const app = await testRender(() => <Fixture />, { width: 42, height: 80 })
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes("[T1] b1 : first"))
      expect(frame).not.toContain("▸")
      const row = rowOf(app, "[T1] b1 : first")
      await app.mockMouse.moveTo(2, row)
      await app.waitForFrame((value) => value.includes("▸"))
      await app.mockMouse.moveTo(2, 0)
      await app.waitForFrame((value) => !value.includes("▸"))
    } finally {
      app.renderer.destroy()
    }
  })

  test("点击摘要块打开 markdown 弹窗", async () => {
    capturedDialog = undefined
    const app = await testRender(() => <Fixture />, { width: 42, height: 80 })
    app.renderer.start()
    try {
      await app.waitForFrame((value) => value.includes("[T1] b1 : first"))
      await app.mockMouse.click(2, rowOf(app, "[T1] b1 : first"))
      expect(capturedDialog).toBeDefined()
      const dialog = await testRender(capturedDialog!, { width: 50, height: 24 })
      dialog.renderer.start()
      try {
        const frame = await dialog.waitForFrame((value) => value.includes("BODY_MARKER"))
        expect(frame).toContain("[T1] b1 : first")
      } finally {
        dialog.renderer.destroy()
      }
    } finally {
      app.renderer.destroy()
    }
  })

  test("上下文构成使用真实 usage 计算百分比", async () => {
    const app = await testRender(
      () => <Fixture initial={{ contextLimit: 50_000 }} used={31_419} />,
      { width: 42, height: 40 },
    )
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes("上下文构成"))
      expect(frame).toContain("上下文构成 (63%)")
    } finally {
      app.renderer.destroy()
    }
  })

  test("缓存日志默认折叠，点击日志后展开", async () => {
    const app = await testRender(() => <Fixture />, { width: 42, height: 80 })
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes("日志"))
      expect(frame).not.toContain("输入")
      await app.mockMouse.click(2, rowOf(app, "日志"))
      await app.waitForFrame((value) => value.includes("输入"))
    } finally {
      app.renderer.destroy()
    }
  })

  test("折叠上下文构成时缓存与摘要仍然可见", async () => {
    const app = await testRender(() => <Fixture initial={{ expanded: false }} />, {
      width: 42,
      height: 60,
    })
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes("上下文构成"))
      expect(frame).toContain("缓存记录")
      expect(frame).toContain("摘要块")
    } finally {
      app.renderer.destroy()
    }
  })

  test("关闭显示开关后隐藏缓存与摘要", async () => {
    const app = await testRender(
      () => (
        <Fixture
          initial={{ showCacheChart: false, showCacheLog: false, showSummaries: false }}
        />
      ),
      { width: 42, height: 80 },
    )
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes("上下文构成"))
      expect(frame).not.toContain("缓存记录")
      expect(frame).not.toContain("折线图")
      expect(frame).not.toContain("摘要块")
    } finally {
      app.renderer.destroy()
    }
  })
})
