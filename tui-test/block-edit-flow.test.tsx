import { testRender } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal, Show, type JSX } from "solid-js"

import { resolveMessages } from "../src/i18n/index.ts"
import type { SummaryBlock } from "../src/shared/blocks.ts"
import { DEFAULT_SETTINGS, type Settings } from "../src/shared/settings.ts"
import { SummarySection } from "../src/tui/panel/summaries.tsx"

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

const BODY = "T=标题|G=目标\nPREFILL_MARKER"

/** 输入：无；输出：一条 Babel 块。 */
function fakeBlock(): SummaryBlock {
  return {
    id: "b1",
    tier: 1,
    height: 1,
    format: "babel",
    title: "块标题",
    at: 1234,
    sourceTokens: 5000,
    summaryTokens: 10,
    body: BODY,
  }
}

const settings = (): Settings => ({
  ...DEFAULT_SETTINGS,
  locale: "zh",
  showSummaries: true,
  summariesExpanded: true,
})

/** 记录 RPC 调用；返回固定成功。 */
const calls: { method: string; input: unknown }[] = []

/**
 * 输入：渲染根。
 * 输出：带真实弹窗宿主（show/clear 会真的替换画面）的摘要分区。
 * 预期：点击块行 → 阅读弹窗 → 点 ✎ → 编辑器；用于验证整条鼠标链路。
 */
function Flow() {
  const [dialog, setDialog] = createSignal<(() => JSX.Element) | undefined>(undefined)
  const context = {
    theme: fakeTheme(),
    renderer: { height: 40 },
    location: { directory: "/work" },
    ui: {
      dialog: {
        show: (render: () => JSX.Element) => setDialog(() => render),
        set: () => {},
        clear: () => setDialog(undefined),
      },
      toast: { show: () => {} },
    },
    client: {
      rpc: () => ({
        blockUpdate: (input: unknown) => {
          calls.push({ method: "blockUpdate", input })
          return Promise.resolve({ ok: true })
        },
      }),
    },
  } as unknown as Context
  return (
    <box flexDirection="column">
      <SummarySection
        context={context}
        theme={fakeTheme()}
        copy={resolveMessages("zh")}
        settings={settings()}
        updateSettings={() => Promise.resolve()}
        blocks={[fakeBlock()]}
        sessionID="ses_a"
        onSaved={() => {}}
      />
      <Show when={dialog()}>{(render) => <>{render()()}</>}</Show>
    </box>
  )
}

/** 输入：帧 + 文本；输出：该文本所在行号；找不到返回 -1。 */
function rowOf(frame: string, text: string): number {
  return frame.split("\n").findIndex((line) => line.includes(text))
}

/**
 * 输入：一行文本 + 目标列索引（字符下标）。
 * 输出：终端显示列。
 * 预期：CJK 与 emoji 占两列，直接用字符下标记会点偏。
 */
function displayColumn(line: string, index: number): number {
  let column = 0
  for (const char of Array.from(line).slice(0, index)) {
    column += (char.codePointAt(0) ?? 0) > 0x1100 ? 2 : 1
  }
  return column
}

describe("摘要块编辑链路", () => {
  test("点块行 → 点 ✎ → 原文预填 → ctrl+s 提交", async () => {
    calls.length = 0
    const app = await testRender(() => <Flow />, { width: 70, height: 30 })
    app.renderer.start()
    try {
      // 1. 点块行打开阅读弹窗。
      const list = await app.waitForFrame((value) => value.includes("块标题"))
      const row = rowOf(list, "块标题")
      expect(row).toBeGreaterThanOrEqual(0)
      await app.mockMouse.click(6, row)
      const reader = await app.waitForFrame((value) => value.includes("esc"))
      expect(reader).toContain("✎")

      // 2. 点 ✎ 进入编辑器（✎ 紧挨 esc 左侧，按 esc 的显示列反推，避免宽字符算错）。
      const readerLine = reader.split("\n").find((line) => line.includes("esc")) ?? ""
      const escColumn = displayColumn(readerLine, readerLine.indexOf("esc"))
      const headerRow = rowOf(reader, "esc")
      let editor: string | undefined
      for (const x of [escColumn - 2, escColumn - 3, escColumn - 4]) {
        await app.mockMouse.click(x, headerRow)
        try {
          editor = await app.waitForFrame(
            (value) => value.includes(resolveMessages("zh").blockEditor.title),
            { maxPasses: 20 },
          )
          break
        } catch {
          // 没点中，换下一个列
        }
      }
      expect(editor).toBeDefined()
      expect(editor).toContain("PREFILL_MARKER")

      // 3. 直接打字（光标在开头）+ ctrl+s 提交。
      await app.mockInput.typeText("X")
      app.mockInput.pressKey("s", { ctrl: true })
      await Bun.sleep(50)
      expect(calls).toHaveLength(1)
      const input = calls[0]?.input as {
        sessionID: string
        blockID: string
        expectedAt: number
        text: string
      }
      expect(input.sessionID).toBe("ses_a")
      expect(input.blockID).toBe("b1")
      expect(input.expectedAt).toBe(1234)
      expect(input.text).toBe(`X${BODY}`)
    } finally {
      app.renderer.destroy()
    }
  })
})
