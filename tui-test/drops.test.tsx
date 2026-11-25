import { testRender } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"
import type { JSX } from "solid-js"

import { resolveMessages } from "../src/i18n/index.ts"
import type { CacheDrop } from "../src/shared/cache-drops.ts"
import { DEFAULT_SETTINGS, type Settings } from "../src/shared/settings.ts"
import { DropsDialog } from "../src/tui/panel/drops-dialog.tsx"
import { DropsSection } from "../src/tui/panel/drops.tsx"

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
    kind: "compaction",
    cause: "system",
    breakPoint: { segment: "system[0]", offset: 3, before, after },
    outline: [
      { key: "system[0]", chars: 4 },
      { key: "messages[0]", chars: 10 },
    ],
    request: { segment: "system[0]", text: `{"role":"system","content":"${after}"}`, truncated: false },
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
  readonly onOpen?: (messageID?: string) => void
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
      expect(frame).toContain(copy.drops.causeIcon.system)
      expect(frame).toContain("sys[0]")
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

  test("没有记录时显示空态", async () => {
    const app = await testRender(() => <SectionFixture drops={[]} initial={{ cacheDropsEnabled: true }} />, {
      width: 80,
      height: 20,
    })
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes(copy.drops.empty))
      expect(frame).toContain(copy.drops.title)
    } finally {
      app.renderer.destroy()
    }
  })

  test("侧栏最多显示最近 10 条，总数仍完整", async () => {
    const many = Array.from({ length: 12 }, (_, index) => drop(`m${index.toString()}`, index + 1, "AAAA", "AABA"))
    const app = await testRender(
      () => <SectionFixture drops={many} initial={{ cacheDropsEnabled: true }} />,
      { width: 80, height: 20 },
    )
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes(copy.drops.title))
      expect(frame).toContain("(12)")
      expect(frame).toContain("-12.0pp")
      expect(frame).not.toContain("-1.0pp")
      // 「还有 2 条」与记录行一样缩进两格。
      expect(frame.split("\n").some((line) => line.startsWith("  还有 2 条"))).toBe(true)
    } finally {
      app.renderer.destroy()
    }
  })

  test("点击「还有 N 条」也会打开弹窗", async () => {
    const many = Array.from({ length: 12 }, (_, index) => drop(`m${index.toString()}`, index + 1, "AAAA", "AABA"))
    let opened = 0
    const app = await testRender(
      () => (
        <SectionFixture
          drops={many}
          initial={{ cacheDropsEnabled: true }}
          onOpen={() => {
            opened += 1
          }}
        />
      ),
      { width: 80, height: 20 },
    )
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes("还有 2 条"))
      const row = frame.split("\n").findIndex((line) => line.includes("还有 2 条"))
      await app.mockMouse.click(3, row)
      expect(opened).toBe(1)
    } finally {
      app.renderer.destroy()
    }
  })

  test("点击记录行会带着 messageID 打开弹窗", async () => {
    const opened: string[] = []
    const app = await testRender(
      () => (
        <SectionFixture
          drops={[drop("m2", 50, "AAAA", "AABA")]}
          initial={{ cacheDropsEnabled: true }}
          onOpen={(messageID) => {
            if (messageID !== undefined) opened.push(messageID)
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

/** 输入：记录 + 初始选中 id；输出：阅读弹窗内容 fixture。 */
function DialogFixture(props: {
  readonly drops: readonly CacheDrop[]
  readonly initial?: string
}) {
  const [settings] = createSignal<Settings>({
    ...DEFAULT_SETTINGS,
    locale: "zh",
    cacheDropsEnabled: true,
    showCacheDrops: true,
  })
  const context = fakeContext(props.drops, settings)
  return (
    <DropsDialog
      context={context}
      sessionID="ses_a"
      settings={settings()}
      {...(props.initial === undefined ? {} : { initial: props.initial })}
    />
  )
}

describe("DropsDialog", () => {
  test("渲染列表、断点差异与原始请求", async () => {
    const app = await testRender(
      () => <DialogFixture drops={[drop("m2", 50, "AAAA", "AABA")]} initial="m2" />,
      { width: 120, height: 32 },
    )
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes(copy.drops.panelTitle))
      expect(frame).toContain("-50.0pp")
      expect(frame).toContain(copy.drops.kind.compaction)
      expect(frame).toContain(copy.drops.structure)
      expect(frame).toContain(copy.drops.request)
      expect(frame).toContain("AABA")
      expect(frame).toContain(copy.drops.break)
      expect(frame).toContain(copy.drops.footer)
      expect(frame).toContain("esc")
    } finally {
      app.renderer.destroy()
    }
  })

  test("空态给出明确提示", async () => {
    const app = await testRender(() => <DialogFixture drops={[]} />, { width: 120, height: 32 })
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes(copy.drops.empty))
      expect(frame).toContain(copy.drops.panelTitle)
    } finally {
      app.renderer.destroy()
    }
  })

  test("点击列表项会切换详情", async () => {
    const drops = [drop("m1", 20, "AAAA", "AAAB"), drop("m2", 50, "CCCC", "CCCD")]
    const app = await testRender(() => <DialogFixture drops={drops} initial="m2" />, {
      width: 120,
      height: 32,
    })
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes("CCCD"))
      expect(frame).toContain("CCCD")
      const row = frame.split("\n").findIndex((line) => line.includes("-20.0pp"))
      await app.mockMouse.click(4, row)
      const after = await app.waitForFrame((value) => value.includes("AAAB"))
      expect(after).toContain("AAAB")
    } finally {
      app.renderer.destroy()
    }
  })
})
