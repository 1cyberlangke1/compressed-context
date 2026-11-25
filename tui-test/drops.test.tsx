import { testRender } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"
import type { JSX } from "solid-js"

import { resolveMessages } from "../src/i18n/index.ts"
import type { CacheDrop } from "../src/shared/cache-drops.ts"
import { DEFAULT_SETTINGS, type Settings } from "../src/shared/settings.ts"
import { DropsSection } from "../src/tui/panel/drops.tsx"
import { DropsView } from "../src/tui/panel/drops-panel.tsx"

const copy = resolveMessages("zh")

/** 输入：无；输出：缓存突变组件需要的最小主题。 */
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

/** 输入：id + 跌幅 + 报文差异；输出：一条缓存突变记录。 */
function drop(id: string, dropPp: number, before: string, after: string): CacheDrop {
  return {
    messageID: id,
    at: Date.UTC(2026, 0, 1, 3, 4),
    prevMessageID: `prev-${id}`,
    prompt: 1_000,
    hit: 400,
    hitRate: 40,
    prevPrompt: 1_000,
    prevHit: 900,
    prevHitRate: 90,
    dropPp,
    cause: "system",
    breakPoint: { segment: "system[0]", offset: 3, before, after },
  }
}

/** 输入：记录数组 + 设置；输出：带 RPC 替身的 TUI 上下文。 */
function fakeContext(drops: readonly CacheDrop[], settings: () => Settings): Context {
  return {
    theme: fakeTheme(),
    renderer: { height: 40 },
    location: { directory: "/work" },
    data: {
      on: () => () => {},
    },
    client: {
      rpc: () => ({
        cacheHistoryGet: () => Promise.resolve({ samples: [], drops }),
      }),
    },
  } as unknown as Context
}

/** 输入：初始设置 + 记录 + 打开回调；输出：侧栏分区 fixture。 */
function SectionFixture(props: {
  readonly initial?: Partial<Settings>
  readonly drops: readonly CacheDrop[]
  readonly onOpen?: (messageID: string) => void
}) {
  const [settings, setSettings] = createSignal<Settings>({ ...DEFAULT_SETTINGS, locale: "zh", ...props.initial })
  const context = fakeContext(props.drops, settings)
  const updateSettings = async (mutation: (draft: Settings) => void): Promise<void> => {
    setSettings((previous) => {
      const draft = { ...previous }
      mutation(draft)
      return draft
    })
  }
  return (
    <DropsSection
      context={context}
      sessionID="ses_a"
      settings={settings()}
      updateSettings={updateSettings}
      onOpen={props.onOpen ?? (() => undefined)}
    />
  )
}

/** 输入：app + 文本；输出：该文本所在行号；找不到返回 -1。 */
function rowOf(app: Awaited<ReturnType<typeof testRender>>, text: string): number {
  return app.captureCharFrame().split("\n").findIndex((line) => line.includes(text))
}

describe("DropsSection", () => {
  test("有记录时渲染跌幅、原因与断点", async () => {
    const app = await testRender(
      () => <SectionFixture drops={[drop("m2", 50, "AAAA", "AABA")]} initial={{ cacheDropsEnabled: true }} />,
      { width: 80, height: 20 },
    )
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes(copy.drops.title))
      expect(frame).toContain("(1)")
      expect(frame).toContain("-50.0pp")
      expect(frame).toContain(copy.drops.cause.system)
      expect(frame).toContain("system[0] +3")
    } finally {
      app.renderer.destroy()
    }
  })

  test("总开关关闭时不渲染", async () => {
    const app = await testRender(() => <SectionFixture drops={[drop("m2", 50, "A", "B")]} />, {
      width: 80,
      height: 20,
    })
    app.renderer.start()
    try {
      // 等 RPC 回来再断言：关闭状态下无论数据是否回来都不应出现标题。
      await Bun.sleep(50)
      expect(app.captureCharFrame()).not.toContain(copy.drops.title)
    } finally {
      app.renderer.destroy()
    }
  })

  test("没有记录时不渲染分区标题", async () => {
    const app = await testRender(() => <SectionFixture drops={[]} initial={{ cacheDropsEnabled: true }} />, {
      width: 80,
      height: 20,
    })
    app.renderer.start()
    try {
      await Bun.sleep(50)
      expect(app.captureCharFrame()).not.toContain(copy.drops.title)
    } finally {
      app.renderer.destroy()
    }
  })

  test("点击记录行会带着 messageID 打开面板", async () => {
    const opened: string[] = []
    const app = await testRender(
      () => (
        <SectionFixture
          drops={[drop("m2", 50, "AAAA", "AABA")]}
          initial={{ cacheDropsEnabled: true }}
          onOpen={(messageID) => {
            opened.push(messageID)
          }}
        />
      ),
      { width: 80, height: 20 },
    )
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes("-50.0pp"))
      const row = frame.split("\n").findIndex((line) => line.includes("-50.0pp"))
      await app.mockMouse.click(2, row)
      expect(opened).toEqual(["m2"])
    } finally {
      app.renderer.destroy()
    }
  })
})

/** 输入：记录 + 选中 id + 回调；输出：全宽面板 fixture。 */
function PanelFixture(props: {
  readonly drops: readonly CacheDrop[]
  readonly selected?: string
  readonly onSelect?: (messageID: string) => void
}) {
  const [settings] = createSignal<Settings>({
    ...DEFAULT_SETTINGS,
    locale: "zh",
    cacheDropsEnabled: true,
  })
  const context = fakeContext(props.drops, settings)
  return (
    <DropsView
      context={context}
      sessionID="ses_a"
      settings={settings()}
      selected={props.selected}
      onSelect={props.onSelect ?? (() => undefined)}
    />
  )
}

describe("DropsView", () => {
  test("渲染列表与 was/now 差异", async () => {
    const app = await testRender(
      () => <PanelFixture drops={[drop("m2", 50, "AAAA", "AABA")]} selected="m2" />,
      { width: 100, height: 30 },
    )
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes(copy.drops.panelTitle))
      expect(frame).toContain("-50.0pp")
      expect(frame).toContain(copy.drops.was)
      expect(frame).toContain(copy.drops.now)
      // was/now 各自把不同字符高亮出来；这里只断言两侧原文都在。
      expect(frame).toContain("AAAA")
      expect(frame).toContain("AABA")
    } finally {
      app.renderer.destroy()
    }
  })

  test("空态给出明确提示", async () => {
    const app = await testRender(() => <PanelFixture drops={[]} />, { width: 100, height: 30 })
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes(copy.drops.empty))
      expect(frame).toContain(copy.drops.panelTitle)
    } finally {
      app.renderer.destroy()
    }
  })

  test("点击列表项会切换选中记录", async () => {
    const selected: string[] = []
    const drops = [drop("m1", 20, "AAAA", "AAAB"), drop("m2", 50, "CCCC", "CCCD")]
    const app = await testRender(
      () => (
        <PanelFixture
          drops={drops}
          selected="m2"
          onSelect={(messageID) => {
            selected.push(messageID)
          }}
        />
      ),
      { width: 100, height: 30 },
    )
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes("CCCD"))
      const row = frame.split("\n").findIndex((line) => line.includes("-20.0pp"))
      await app.mockMouse.click(2, row)
      expect(selected).toEqual(["m1"])
    } finally {
      app.renderer.destroy()
    }
  })
})
