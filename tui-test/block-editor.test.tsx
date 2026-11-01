import { testRender } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"

import { resolveMessages } from "../src/i18n/index.ts"
import type { SummaryBlock } from "../src/shared/blocks.ts"
import { BlockEditorDialog } from "../src/tui/panel/block-editor.tsx"
import { SummaryDialog } from "../src/tui/panel/summaries.tsx"

/** 输入：无；输出：弹窗需要的最小主题。 */
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

/** 输入：无；输出：弹窗需要的最小上下文。 */
function fakeContext(height = 40): Context {
  return {
    theme: fakeTheme(),
    renderer: { height },
    location: { directory: "/work" },
    ui: {
      dialog: { show: () => {}, set: () => {}, clear: () => {} },
      toast: { show: () => {} },
    },
    client: { rpc: () => ({}) },
  } as unknown as Context
}

/** 输入：无；输出：一个带固定正文的 Babel 块。 */
function fakeBlock(): SummaryBlock {
  return {
    id: "b1",
    tier: 1,
    height: 1,
    format: "babel",
    title: "标题",
    at: 1,
    sourceTokens: 100,
    summaryTokens: 10,
    body: "T=标题|G=目标\nPREFILL_MARKER",
  }
}

const copy = resolveMessages("zh").blockEditor

describe("摘要块弹窗", () => {
  test("阅读弹窗右上角先 ✎ 后 esc", async () => {
    const app = await testRender(
      () => (
        <SummaryDialog
          context={fakeContext()}
          theme={fakeTheme()}
          block={fakeBlock()}
          copy={copy}
          sessionID="ses_a"
          onSaved={() => {}}
        />
      ),
      { width: 60, height: 20 },
    )
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes("esc"))
      const header = frame.split("\n").find((line) => line.includes("esc")) ?? ""
      expect(header).toContain("✎")
      // esc 恒在最右：✎ 必须出现在 esc 左边。
      expect(header.indexOf("✎")).toBeLessThan(header.indexOf("esc"))
    } finally {
      app.renderer.destroy()
    }
  })

  test("编辑器直接预填原正文，不是空白输入框", async () => {    const app = await testRender(
      () => (
        <BlockEditorDialog
          context={fakeContext(24)}
          copy={copy}
          sessionID="ses_a"
          block={fakeBlock()}
          onSaved={() => {}}
        />
      ),
      { width: 60, height: 24 },
    )
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes("PREFILL_MARKER"))
      expect(frame).toContain(copy.title)
      expect(frame).toContain("PREFILL_MARKER")
      expect(frame).toContain(copy.hint)
    } finally {
      app.renderer.destroy()
    }
  })

  test("鼠标悬停 ✎ 变青、esc 变红", async () => {
    const app = await testRender(
      () => (
        <SummaryDialog
          context={fakeContext()}
          theme={fakeTheme()}
          block={fakeBlock()}
          copy={copy}
          sessionID="ses_a"
          onSaved={() => {}}
        />
      ),
      { width: 60, height: 20 },
    )
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes("esc"))
      const line = frame.split("\n").find((value) => value.includes("esc")) ?? ""
      const row = frame.split("\n").findIndex((value) => value.includes("esc"))
      /** 输入：行内字符下标；输出：终端显示列（CJK 占两列）。 */
      const column = (index: number): number => {
        let width = 0
        for (const char of Array.from(line).slice(0, index)) {
          width += (char.codePointAt(0) ?? 0) > 0x1100 ? 2 : 1
        }
        return width
      }
      /** 输入：子串；输出：该子串第一个 span 的前景色。 */
      const foreground = (needle: string): readonly number[] => {
        const captured = app.captureSpans()
        for (const capturedLine of captured.lines) {
          for (const span of capturedLine.spans) {
            if (span.text.includes(needle)) {
              // 截帧里的颜色是 0-1 归一化的，转回 0-255 好写断言。
              return [span.fg.r, span.fg.g, span.fg.b].map((value) => Math.round(value * 255))
            }
          }
        }
        return []
      }

      // 悬停前：两个都是 muted (#888888)。
      expect(foreground("esc")).toEqual([136, 136, 136])

      await app.mockMouse.moveTo(column(line.indexOf("esc")), row)
      await Bun.sleep(50)
      expect(foreground("esc")).toEqual([255, 0, 0])

      await app.mockMouse.moveTo(column(line.indexOf("✎")), row)
      await Bun.sleep(50)
      expect(foreground("✎")).toEqual([0, 170, 255])
    } finally {
      app.renderer.destroy()
    }
  })
})

