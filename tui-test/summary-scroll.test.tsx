import { testRender } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"

import { resolveMessages } from "../src/i18n/index.ts"
import type { SummaryBlock } from "../src/shared/blocks.ts"
import { DEFAULT_SETTINGS } from "../src/shared/settings.ts"
import { SummarySection } from "../src/tui/panel/summaries.tsx"

/** 输入：无；输出：侧栏需要的最小主题。 */
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

/** 输入：数量；输出：这么多条 Babel 块，id 从 b1 递增。 */
function fakeBlocks(count: number): SummaryBlock[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `b${(index + 1).toString()}`,
    tier: 1,
    height: 1,
    format: "babel" as const,
    title: `block-${(index + 1).toString()}`,
    at: index + 1,
    sourceTokens: 1000,
    summaryTokens: 10,
    body: `T=block-${(index + 1).toString()}|G=test\nS[mod]:x`,
  }))
}

/** 输入：块数量；输出：只渲染摘要分区的根组件。 */
function Fixture(props: { readonly count: number }) {
  const context = {
    theme: fakeTheme(),
    renderer: { height: 24 },
    location: { directory: "/work" },
    keymap: { layer: () => {} },
    ui: {
      dialog: { show: () => {}, set: () => {}, clear: () => {} },
      toast: { show: () => {} },
    },
    client: { rpc: () => ({}) },
  } as unknown as Context
  return (
    <SummarySection
      context={context}
      theme={fakeTheme()}
      copy={resolveMessages("zh")}
      settings={{
        ...DEFAULT_SETTINGS,
        locale: "zh",
        showSummaries: true,
        summariesExpanded: true,
        showTimeline: false,
        showBlockTokens: false,
      }}
      updateSettings={() => Promise.resolve()}
      blocks={fakeBlocks(props.count)}
      sessionID="ses_a"
      onSaved={() => {}}
    />
  )
}

describe("摘要块列表滚动", () => {
  test("块很多时列表高度固定，滚轮能翻到后面的块", async () => {
    const app = await testRender(() => <Fixture count={30} />, { width: 60, height: 24 })
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes("b1 :"))
      // 固定 5 行：早期的块在，最后一块不在。
      expect(frame).toContain("b1 :")
      expect(frame).not.toContain("b30 :")
      // 整段列表高度不超过固定值（不会把侧栏撑长）。
      expect(frame.split("\n").filter((line) => line.includes(" : block-")).length).toBeLessThanOrEqual(5)

      // 滚轮向下翻，最后一块应当出现。
      for (let step = 0; step < 80; step += 1) {
        await app.mockMouse.scroll(10, 3, "down")
      }
      const scrolled = await app.waitForFrame((value) => value.includes("b30 :"))
      expect(scrolled).toContain("b30 :")
    } finally {
      app.renderer.destroy()
    }
  })
})

