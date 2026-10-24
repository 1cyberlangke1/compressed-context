import { testRender } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import type { Context, DialogSelectOptions } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"

import { resolveMessages } from "../src/i18n/index.ts"
import { DEFAULT_SETTINGS, type Settings } from "../src/shared/settings.ts"
import { SettingsCommand } from "../src/tui/settings.tsx"
import { TokenDialog } from "../src/tui/settings/dialogs.tsx"

interface Captured {
  options?: DialogSelectOptions<string>
  run?: () => void
  readonly answers: (string | undefined)[]
  /** 主菜单 select 调用次数（用于断言“弹窗型动作不重开菜单”）。 */
  selects: number
  /** dialog.show 调用次数。 */
  shows: number
}

/** 输入：捕获对象；输出：SettingsCommand 需要的最小上下文。 */
function fakeContext(captured: Captured): Context {
  return {
    theme: {
      text: {
        base: "#ffffff",
        muted: "#888888",
        formfield: { base: "#ffffff" },
        feedback: { error: { base: "#ff0000" } },
      },
    },
    keymap: {
      layer: (factory: () => { commands: readonly { run: () => void }[] }) => {
        captured.run = factory().commands[0]?.run
        return () => {}
      },
    },
    ui: {
      dialog: {
        select: (options: DialogSelectOptions<string>) => {
          captured.selects += 1
          captured.options = options
          return Promise.resolve(captured.answers.shift())
        },
        show: () => {
          captured.shows += 1
        },
        clear: () => {},
      },
      router: { current: () => ({ type: "session", sessionID: "ses_a" }) },
      model: { current: () => ({ providerID: "google", modelID: "gemini-3-pro" }) },
    },
    // 模型列表在真实 TUI 里来自 location 数据；测试给一个空列表即可。
    data: {
      location: {
        model: { list: () => [] },
      },
    },
    client: {
      rpc: () => ({
        settingsGet: () => Promise.resolve({ resolvedWindow: 200_000 }),
        settingsSet: () => Promise.resolve({ ok: true }),
      }),
    },
  } as unknown as Context
}

/** 输入：每次 select 的返回值队列；输出：渲染好的 app + 捕获对象 + 设置信号。 */
async function mount(answers: (string | undefined)[]) {
  const captured: Captured = { answers, selects: 0, shows: 0 }
  const context = fakeContext(captured)
  const [settings, setSettings] = createSignal<Settings>({
    ...DEFAULT_SETTINGS,
    // 断言中文文案，不能依赖跑测试那台机器的系统语言。
    locale: "zh",
  })
  const updateSettings = async (mutation: (draft: Settings) => void): Promise<void> => {
    setSettings((previous) => {
      const draft = { ...previous }
      mutation(draft)
      return draft
    })
  }
  const app = await testRender(
    () => <SettingsCommand context={context} settings={settings()} updateSettings={updateSettings} />,
    { width: 40, height: 20 },
  )
  app.renderer.start()
  await app.waitFor(() => captured.run !== undefined)
  return { app, captured, settings }
}

describe("SettingsCommand", () => {
  test("打开菜单时按分类分组", async () => {
    const { app, captured } = await mount([])
    try {
      captured.run?.()
      await app.waitFor(() => captured.options !== undefined)
      const options = captured.options?.options ?? []
      expect(options.map((option) => option.value)).toContain("showCacheChart")
      expect(options.map((option) => option.value)).toContain("showCacheLog")
      expect(options.map((option) => option.value)).toContain("showSummaries")
      expect(options.map((option) => option.value)).toContain("summaryFormat")
      expect(options.map((option) => option.value)).toContain("modelCurrent")
      expect(options.map((option) => option.value)).toContain("modelOverrides")
      expect([...new Set(options.map((option) => option.category))]).toEqual([
        "压缩",
        "摘要",
        "面板",
        "解压",
        "界面",
        "按模型",
      ])
    } finally {
      app.renderer.destroy()
    }
  })

  test("选择 showCacheChart 会翻转设置", async () => {
    const { app, captured, settings } = await mount(["showCacheChart", undefined])
    try {
      captured.run?.()
      await app.waitFor(() => settings().showCacheChart === false)
      expect(settings().showCacheChart).toBe(false)
    } finally {
      app.renderer.destroy()
    }
  })

  test("选择 summaryFormat 会切到 json", async () => {
    const { app, captured, settings } = await mount(["summaryFormat", "json", undefined])
    try {
      captured.run?.()
      await app.waitFor(() => settings().summaryFormat === "json")
      expect(settings().summaryFormat).toBe("json")
    } finally {
      app.renderer.destroy()
    }
  })

  test("取消主菜单时不写设置也不重开", async () => {
    const { app, captured, settings } = await mount([undefined])
    try {
      captured.run?.()
      await app.waitFor(() => captured.selects === 1)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(captured.selects).toBe(1)
      expect(settings().enabled).toBe(true)
    } finally {
      app.renderer.destroy()
    }
  })

  test("弹窗型动作只开弹窗，不重开主菜单", async () => {
    const { app, captured } = await mount(["nudge"])
    try {
      captured.run?.()
      await app.waitFor(() => captured.shows === 1)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(captured.selects).toBe(1)
    } finally {
      app.renderer.destroy()
    }
  })

  test("limit 选自定义时只继续开输入框", async () => {
    const { app, captured } = await mount(["limit", "custom"])
    try {
      captured.run?.()
      await app.waitFor(() => captured.shows === 1)
      await new Promise((resolve) => setTimeout(resolve, 20))
      // 主菜单一次 + limit 选择一次；自定义输入框已经打开，不能再弹主菜单。
      expect(captured.selects).toBe(2)
    } finally {
      app.renderer.destroy()
    }
  })

  test("nudge 间隔 0 是合法值，不显示 invalid", async () => {
    const captured: Captured = { answers: [] }
    const context = fakeContext(captured)
    const copy = resolveMessages("zh")
    const app = await testRender(
      () => (
        <TokenDialog
          context={context}
          copy={copy}
          title={copy.settings.nudgeGrowth}
          hint={copy.settings.nudgeGrowthHint}
          invalid={copy.settings.nudgeGrowthInvalid}
          placeholder="50k"
          initial="0"
          min={0}
          max={200_000}
          allowZero
          onConfirm={() => {}}
        />
      ),
      { width: 60, height: 20 },
    )
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((value) => value.includes(copy.settings.nudgeGrowth))
      expect(frame).not.toContain(copy.settings.nudgeGrowthInvalid)
    } finally {
      app.renderer.destroy()
    }
  })
})
