import { testRender } from "@opentui/solid"
import { ScrollBoxRenderable, type BaseRenderable } from "@opentui/core"
import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"

import { resolveMessages } from "../src/i18n/index.ts"
import type { CacheDrop, CacheDropNode } from "../src/shared/cache-drops.ts"
import { DEFAULT_SETTINGS, type Settings } from "../src/shared/settings.ts"
import { DropCompare } from "../src/tui/panel/drops-compare.tsx"
import { DropsDialog, NodeTextDialog } from "../src/tui/panel/drops-dialog.tsx"

const copy = resolveMessages("zh")

/** 输入：无；输出：对比组件需要的最小主题。 */
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

/** 输入：记录；输出：带 RPC 替身的 TUI 上下文。 */
function fakeContext(drops: readonly CacheDrop[]): Context {
  return {
    theme: fakeTheme(),
    renderer: { height: 40, width: 120 },
    location: { directory: "/work" },
    ui: {
      dialog: {
        show: () => {},
        set: () => {},
        clear: () => {},
      },
    },
    data: {
      on: () => () => {},
    },
    keymap: {
      layer: () => {},
    },
    client: {
      rpc: () => ({
        cacheHistoryGet: () => Promise.resolve({ samples: [], drops }),
      }),
    },
  } as unknown as Context
}

/** 输入：id + 可选内联报文；输出：一条带断点的缓存突变记录。 */
function drop(id: string, bodies?: CacheDrop["bodies"]): CacheDrop {
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
    dropPp: 50,
    kind: "primary",
    cause: "system",
    breakPoint: { segment: "system[0]", offset: 3, before: "AAAA", after: "AABA" },
    request: { segment: "system[0]", text: '{"role":"system","content":"AABA"}', truncated: false },
    ...(bodies === undefined ? {} : { bodies }),
  }
}

/**
 * 输入：一帧文本 + 行内锚点 + 可选行匹配函数。
 * 输出：命中行的行号与锚点所在显示列。
 * 预期：不写死坐标，CJK 宽度差异下仍点中目标。
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
  const width = Array.from(index < 0 ? "" : line.slice(0, index)).reduce((sum, char) => {
    const code = char.codePointAt(0) ?? 0
    const wide = code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f
    return sum + (wide ? 2 : 1)
  }, 0)
  return { row, col: width + 1 }
}

/**
 * 输入：渲染树节点；输出：树里全部 scrollbox 渲染节点。
 * 预期：横向滚动断言用；scrollWidth 是布局内容宽，被视口拉伸时等于自身宽度。
 */
function collectScrollboxes(node: BaseRenderable, out: ScrollBoxRenderable[] = []): ScrollBoxRenderable[] {
  for (const child of node.getChildren()) {
    if (child instanceof ScrollBoxRenderable) out.push(child)
    collectScrollboxes(child, out)
  }
  return out
}

describe("DropCompare", () => {
  test("左右两栏各自带行号，变化行用 -/+ 标出", async () => {
    const record = drop("m2", {
      body: '{"model":"m","system":"B"}',
      previousBody: '{"model":"m","system":"A"}',
    })
    const app = await testRender(
      () => <DropCompare context={fakeContext([])} sessionID="ses_a" drop={record} copy={copy} onBack={() => {}} />,
      { width: 120, height: 40 },
    )
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes(copy.drops.compareTitle))
      expect(frame).toContain(copy.drops.prevColumn)
      expect(frame).toContain(copy.drops.curColumn)
      expect(frame).toMatch(/- *"system": *"A"/)
      expect(frame).toMatch(/\+ *"system": *"B"/)
      expect(frame).toContain("1")
    } finally {
      app.renderer.destroy()
    }
  })

  test("没有内联报文时退回记录里的断点摘录", async () => {
    const app = await testRender(
      () => <DropCompare context={fakeContext([])} sessionID="ses_a" drop={drop("m2")} copy={copy} onBack={() => {}} />,
      { width: 120, height: 40 },
    )
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes(copy.drops.compareTitle))
      expect(frame).toMatch(/- *AAAA/)
      expect(frame).toMatch(/\+ *AABA/)
    } finally {
      app.renderer.destroy()
    }
  })

  test("点 esc 返回上一层", async () => {
    let backs = 0
    const app = await testRender(
      () => (
        <DropCompare
          context={fakeContext([])}
          sessionID="ses_a"
          drop={drop("m2")}
          copy={copy}
          onBack={() => {
            backs += 1
          }}
        />
      ),
      { width: 120, height: 40 },
    )
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes(copy.drops.compareTitle))
      const esc = locate(frame, copy.drops.closeLabel)
      await app.mockMouse.click(esc.col, esc.row)
      expect(backs).toBe(1)
    } finally {
      app.renderer.destroy()
    }
  })

  test("左右两栏在同一行同时出现", async () => {
    const app = await testRender(
      () => (
        <DropCompare
          context={fakeContext([])}
          sessionID="ses_a"
          drop={drop("m2", { body: "a", previousBody: "b" })}
          copy={copy}
          onBack={() => {}}
        />
      ),
      { width: 120, height: 40 },
    )
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes(copy.drops.prevColumn))
      const header = frame.split("\n").find((line) => line.includes(copy.drops.prevColumn)) ?? ""
      expect(header).toContain(copy.drops.curColumn)
      expect(frame).not.toContain("‹")
    } finally {
      app.renderer.destroy()
    }
  })

  test("完整报文很长也能读进来（不截断）", async () => {
    const long = `{"content":"${"x".repeat(5000)}"}`
    const app = await testRender(
      () => (
        <DropCompare
          context={fakeContext([])}
          sessionID="ses_a"
          drop={drop("m2", { body: long, previousBody: long })}
          copy={copy}
          onBack={() => {}}
        />
      ),
      { width: 120, height: 40 },
    )
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes(copy.drops.compareTitle))
      expect(frame).toContain("xxxx")
    } finally {
      app.renderer.destroy()
    }
  })

  test("最长行超出栏宽时横向能滚到行尾", async () => {
    const long = `{"content":"${"x".repeat(300)}"}`
    const app = await testRender(
      () => (
        <DropCompare
          context={fakeContext([])}
          sessionID="ses_a"
          drop={drop("m2", { body: long, previousBody: long })}
          copy={copy}
          onBack={() => {}}
        />
      ),
      { width: 120, height: 40 },
    )
    app.renderer.start()
    try {
      await app.waitForFrame((value) => value.includes(copy.drops.compareTitle))
      const boxes = collectScrollboxes(app.renderer.root)
      const columns = boxes.filter((box) => box.scrollX)
      expect(columns.length).toBeGreaterThanOrEqual(2)
      // scrollWidth 由 native 布局同步，测试环境读不到；断言布局前提：行盒必须显式比视口宽，
      // 否则 content 被拉伸成视口等宽，横向没有可滚范围。
      for (const column of columns) {
        const widest = Math.max(...column.content.getChildren().map((child) => child.width))
        expect(widest).toBeGreaterThan(column.viewport.width)
      }
    } finally {
      app.renderer.destroy()
    }
  })

  test("节点内容超长行横向能滚到行尾（宽度不封顶 2000）", async () => {
    const node: CacheDropNode = {
      key: "content",
      chars: 3002,
      text: `"${"y".repeat(3000)}"`,
      truncated: false,
    }
    const app = await testRender(
      () => (
        <NodeTextDialog
          context={fakeContext([])}
          copy={copy}
          node={node}
          path={["content"]}
          body={undefined}
          onBack={() => {}}
        />
      ),
      { width: 120, height: 40 },
    )
    app.renderer.start()
    try {
      await app.waitForFrame((value) => value.includes(copy.drops.nodeTitle))
      const boxes = collectScrollboxes(app.renderer.root)
      const column = boxes.at(-1)
      if (column === undefined) throw new Error("scrollbox missing")
      expect(column.scrollX).toBe(true)
      const widest = Math.max(...column.content.getChildren().map((child) => child.width))
      expect(widest).toBeGreaterThan(2000)
    } finally {
      app.renderer.destroy()
    }
  })
})

describe("DropsDialog 的完整对比入口", () => {
  test("点「打开完整对比」切到对比界面", async () => {
    const drops = [drop("m2", { body: "a", previousBody: "b" })]
    const settings: Settings = { ...DEFAULT_SETTINGS, locale: "zh" }
    const context = fakeContext(drops)
    const app = await testRender(
      () => <DropsDialog context={context} sessionID="ses_a" settings={settings} />,
      { width: 120, height: 40 },
    )
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes(copy.drops.openCompare))
      const entry = locate(frame, copy.drops.openCompare)
      await app.mockMouse.click(entry.col, entry.row)
      const compare = await app.waitForFrame((value) => value.includes(copy.drops.compareTitle))
      expect(compare).toContain(copy.drops.prevColumn)
    } finally {
      app.renderer.destroy()
    }
  })

  test("断点摘录显示在「打开完整对比」上面", async () => {
    const drops = [drop("m2")]
    const settings: Settings = { ...DEFAULT_SETTINGS, locale: "zh" }
    const app = await testRender(
      () => <DropsDialog context={fakeContext(drops)} sessionID="ses_a" settings={settings} />,
      { width: 120, height: 40 },
    )
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes(copy.drops.openCompare))
      const breakRow = frame.split("\n").findIndex((line) => line.includes(copy.drops.break))
      const openRow = frame.split("\n").findIndex((line) => line.includes(copy.drops.openCompare))
      expect(breakRow).toBeGreaterThanOrEqual(0)
      expect(openRow).toBeGreaterThan(breakRow)
    } finally {
      app.renderer.destroy()
    }
  })
})
