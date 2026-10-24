import { testRender } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"

import { resolveMessages } from "../src/i18n/index.ts"
import { normalizeSettings, type Settings } from "../src/shared/settings.ts"
import { ModelPanel } from "../src/tui/panel/model.tsx"

// 断言全部对照语言文件，改文案不用动测试；固定 zh 避免跟着机器 locale 漂。
const copy = resolveMessages("zh")

/** 输入：无；输出：ModelPanel 需要的最小上下文。预期：当前模型是 gemini-3-pro，窗口 1M。 */
function fakeContext(): Context {
  return {
    theme: {
      text: {
        base: "#e8e8e8",
        muted: "#888888",
        formfield: { base: "#ffffff" },
        feedback: { error: { base: "#ff0000" } },
      },
    },
    ui: {
      model: { current: () => ({ providerID: "google", modelID: "gemini-3-pro" }) },
      slot: () => () => {},
      dialog: { select: () => Promise.resolve(undefined), show: () => {}, clear: () => {} },
      router: { current: () => ({ type: "session", sessionID: "ses_a" }) },
      toast: { show: () => {} },
    },
    data: {
      location: {
        model: {
          list: () => [
            {
              providerID: "google",
              modelID: "gemini-3-pro",
              name: "Gemini 3 Pro",
              limit: { context: 1_000_000, output: 4096 },
            },
          ],
        },
      },
    },
  } as unknown as Context
}

/** 输入：设置 + 渲染宽度；输出：渲染好的 app。预期：语言固定 zh。 */
async function mount(settings: Settings, width = 120) {
  const context = fakeContext()
  const app = await testRender(
    () => (
      <ModelPanel
        context={context}
        sessionID="ses_a"
        settings={{ ...settings, locale: "zh" }}
        updateSettings={() => Promise.resolve()}
      />
    ),
    { width, height: 12 },
  )
  app.renderer.start()
  return app
}

describe("ModelPanel", () => {
  test("默认设置显示模型名、来源与 emoji 字段", async () => {
    const app = await mount(normalizeSettings({ triggerPercent: 90, summaryBlockPercent: 5, summaryTotalPercent: 7 }))
    try {
      const raw = await app.waitForFrame((value) => value.includes("gemini-3-pro"))
      const frame = raw.replaceAll("\u00A0", " ")
      expect(frame).toContain(copy.modelPanel.sourceGlobal)
      expect(frame).toContain(`${copy.modelPanel.icons.threshold} 90%（900k）`)
      expect(frame).toContain(`${copy.modelPanel.icons.window} 1.0M（${copy.settings.limitAuto}）`)
      expect(frame).toContain(`${copy.modelPanel.icons.block} 5%（50k）`)
      expect(frame).toContain(`${copy.modelPanel.icons.total} 7%（70k）`)
      expect(frame).toContain(`${copy.modelPanel.icons.nudge} 50k`)
    } finally {
      app.renderer.destroy()
    }
  })

  test("全局 + 精确都有贡献时两个来源都显示", async () => {
    const app = await mount(
      normalizeSettings({
        summaryTotalPercent: 40,
        models: { "google/gemini-3-pro": { triggerPercent: 80 } },
      }),
    )
    try {
      const raw = await app.waitForFrame((value) => value.includes("gemini-3-pro"))
      const frame = raw.replaceAll("\u00A0", " ")
      expect(frame).toContain(`${copy.modelPanel.sourceGlobal} + ${copy.modelPanel.sourceExact}`)
      expect(frame).toContain(`${copy.modelPanel.icons.threshold} 80%（800k）`)
      expect(frame).toContain(`${copy.modelPanel.icons.total} 40%（400k）`)
    } finally {
      app.renderer.destroy()
    }
  })

  test("全默认时来源是「默认」", async () => {
    const app = await mount(normalizeSettings({}))
    try {
      const frame = await app.waitForFrame((value) => value.includes("gemini-3-pro"))
      expect(frame).toContain(copy.modelPanel.sourceDefault)
    } finally {
      app.renderer.destroy()
    }
  })

  test("窄宽度下每段数值完整，不会被折行切断", async () => {
    const app = await mount(
      normalizeSettings({ triggerPercent: 88, summaryBlockPercent: 1, summaryTotalPercent: 10 }),
      30,
    )
    try {
      const frame = await app.waitForFrame((value) => value.includes("gemini-3-pro"))
      for (const line of frame.split("\n")) {
        const open = (line.match(/（/g) ?? []).length
        const close = (line.match(/）/g) ?? []).length
        expect(open).toBe(close)
      }
      expect(frame).toContain("880k")
      expect(frame).toContain("10k")
    } finally {
      app.renderer.destroy()
    }
  })
})
