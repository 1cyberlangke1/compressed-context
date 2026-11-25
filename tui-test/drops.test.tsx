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
function drop(id: string, dropPp: number, before: string, after: string, withBreak = true): CacheDrop {
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
    cause: withBreak ? "system" : "append",
    ...(withBreak ? { breakPoint: { segment: "system[0]", offset: 3, before, after } } : {}),
    outline: [
      { key: "system[0]", chars: 4 },
      { key: "messages[0]", chars: 10 },
    ],
    request: { segment: "system[0]", text: `{"role":"system","content":"${after}"}`, truncated: false },
  }
}

/** 输入：记录数组 + 设置 + 可选弹窗回调；输出：带 RPC 替身的 TUI 上下文。 */
function fakeContext(
  drops: readonly CacheDrop[],
  settings: () => Settings,
  onDialogShow?: () => void,
): Context {
  return {
    theme: fakeTheme(),
    renderer: { height: 40 },
    location: { directory: "/work" },
    ui: {
      dialog: {
        show: () => {
          onDialogShow?.()
        },
        set: () => {},
        clear: () => {},
      },
    },
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

/**
 * 输入：一帧文本 + 行内锚点 + 可选行匹配函数（默认匹配含锚点的行）。
 * 输出：命中行的行号与锚点右侧一列。
 * 预期：不依赖固定坐标，终端换行/宽度差异下点击仍落在目标行上。
 */
function locate(
  frame: string,
  anchor: string,
  match: (line: string) => boolean = (line) => line.includes(anchor),
): { readonly row: number; readonly col: number } {
  const lines = frame.split("\n")
  const row = lines.findIndex(match)
  const line = lines[row]
  if (row < 0 || line === undefined) throw new Error(`frame missing ${anchor}`)
  const index = line.indexOf(anchor)
  return { row, col: (index < 0 ? 0 : index) + 2 }
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
  readonly onDialogShow?: () => void
}) {
  const [settings] = createSignal<Settings>({
    ...DEFAULT_SETTINGS,
    locale: "zh",
    cacheDropsEnabled: true,
    showCacheDrops: true,
  })
  const context = fakeContext(props.drops, settings, props.onDialogShow)
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

  test("没有断点时说明前缀未变", async () => {
    const app = await testRender(
      () => <DialogFixture drops={[drop("m2", 50, "AAAA", "AABA", false)]} initial="m2" />,
      { width: 120, height: 32 },
    )
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes(copy.drops.noBreak))
      expect(frame).toContain(copy.drops.causeIcon.append)
      expect(frame).not.toContain(`${copy.drops.break} `)
    } finally {
      app.renderer.destroy()
    }
  })

  test("只追加时显示新增后缀", async () => {
    const tailed: CacheDrop = {
      ...drop("m3", 50, "AAAA", "AABA", false),
      appended: { segment: "messages[1]", offset: 0, before: "", after: "brand-new-content" },
    }
    const app = await testRender(() => <DialogFixture drops={[tailed]} initial="m3" />, {
      width: 120,
      height: 32,
    })
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes(copy.drops.appended))
      expect(frame).toContain("brand-new-content")
      expect(frame).not.toContain(copy.drops.noBreak)
    } finally {
      app.renderer.destroy()
    }
  })

  test("请求结构默认折叠，逐层点击后再展开", async () => {
    const app = await testRender(
      () => <DialogFixture drops={[drop("m2", 50, "AAAA", "AABA")]} initial="m2" />,
      { width: 120, height: 32 },
    )
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes(copy.drops.structure))
      expect(frame).not.toContain("messages (1)")
      const rootRow = frame.split("\n").findIndex((line) => line.includes(copy.drops.structure))
      await app.mockMouse.click(4, rootRow)
      // 顶层展开后，数组仍保持折叠，只显示组名和数量。
      const opened = await app.waitForFrame((value) => value.includes("messages (1)"))
      expect(opened).toContain("system")
      expect(opened).not.toContain("[0] 10 字符")
      const groupRow = opened.split("\n").findIndex((line) => line.includes("messages (1)"))
      await app.mockMouse.click(6, groupRow)
      const expanded = await app.waitForFrame((value) => value.includes("[0] 10 字符"))
      expect(expanded).toContain("[0] 10 字符")
    } finally {
      app.renderer.destroy()
    }
  })

  test("结构树按 JSON 层级逐层缩进展开", async () => {
    const nested: CacheDrop = {
      ...drop("m4", 50, "AAAA", "AABA"),
      tree: [
        {
          key: "messages",
          chars: 120,
          children: [
            {
              key: "[0]",
              chars: 60,
              children: [
                { key: "role", chars: 6 },
                { key: "content", chars: 20 },
              ],
            },
          ],
        },
      ],
    }
    const app = await testRender(() => <DialogFixture drops={[nested]} initial="m4" />, {
      width: 120,
      height: 32,
    })
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes(copy.drops.structure))
      const root = locate(frame, copy.drops.structure)
      await app.mockMouse.click(root.col, root.row)
      const level1 = await app.waitForFrame((value) => value.includes("messages (1)"))
      expect(level1).not.toContain("[0] (2)")
      const messages = locate(level1, "messages", (line) => line.includes("messages (1)"))
      await app.mockMouse.click(messages.col, messages.row)
      const level2 = await app.waitForFrame((value) => value.includes("[0] (2)"))
      const index = locate(level2, "[0]", (line) => line.includes("[0] (2)"))
      await app.mockMouse.click(index.col, index.row)
      const level3 = await app.waitForFrame((value) => value.includes("content"))
      const messagesLine = level3.split("\n").find((line) => line.includes("messages (1)")) ?? ""
      const indexLine = level3.split("\n").find((line) => line.includes("[0] (2)")) ?? ""
      const roleLine = level3.split("\n").find((line) => line.includes("role")) ?? ""
      expect(indexLine.indexOf("[0]")).toBeGreaterThan(messagesLine.indexOf("messages"))
      expect(roleLine.indexOf("role")).toBeGreaterThan(indexLine.indexOf("[0]"))
    } finally {
      app.renderer.destroy()
    }
  })

  test("点击叶子节点打开原始内容弹窗", async () => {
    let shown = 0
    const nested: CacheDrop = {
      ...drop("m5", 50, "AAAA", "AABA"),
      tree: [
        {
          key: "messages",
          chars: 120,
          children: [
            {
              key: "[0]",
              chars: 60,
              children: [{ key: "content", chars: 20, text: "\"hello world\"", truncated: false }],
            },
          ],
        },
      ],
    }
    const app = await testRender(
      () => (
        <DialogFixture
          drops={[nested]}
          initial="m5"
          onDialogShow={() => {
            shown += 1
          }}
        />
      ),
      { width: 120, height: 32 },
    )
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes(copy.drops.structure))
      const root = locate(frame, copy.drops.structure)
      await app.mockMouse.click(root.col, root.row)
      const level1 = await app.waitForFrame((value) => value.includes("messages (1)"))
      const messages = locate(level1, "messages", (line) => line.includes("messages (1)"))
      await app.mockMouse.click(messages.col, messages.row)
      const level2 = await app.waitForFrame((value) => value.includes("[0] (1)"))
      const index = locate(level2, "[0]", (line) => line.includes("[0] (1)"))
      await app.mockMouse.click(index.col, index.row)
      const level3 = await app.waitForFrame((value) => value.includes("content 20"))
      const content = locate(level3, "content", (line) => line.includes("content 20"))
      await app.mockMouse.click(content.col, content.row)
      expect(shown).toBe(1)
    } finally {
      app.renderer.destroy()
    }
  })
})
