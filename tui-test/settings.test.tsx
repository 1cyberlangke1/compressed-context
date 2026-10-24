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
  /** 每次 select 的选项快照，按调用顺序；用于断言三层菜单的每一层。 */
  readonly history: DialogSelectOptions<string>[]
  /** select 调用次数（用于断言“弹窗型动作不重开菜单”）。 */
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
          captured.history.push(options)
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
  const captured: Captured = { answers, history: [], selects: 0, shows: 0 }
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
  test("第一层只有全局默认与按模型", async () => {
    const { app, captured } = await mount([])
    try {
      captured.run?.()
      await app.waitFor(() => captured.history.length >= 1)
      const options = captured.history[0]?.options ?? []
      expect(options.map((option) => option.value)).toEqual(["global", "models"])
      expect(options.map((option) => option.title)).toEqual(["全局默认", "按模型"])
    } finally {
      app.renderer.destroy()
    }
  })

  test("全局默认第二层是六个分组里的五个", async () => {
    const { app, captured } = await mount(["global"])
    try {
      captured.run?.()
      await app.waitFor(() => captured.history.length >= 2)
      const options = captured.history[1]?.options ?? []
      expect(options.map((option) => option.value)).toEqual([
        "compress",
        "summary",
        "panel",
        "decompress",
        "interface",
      ])
    } finally {
      app.renderer.destroy()
    }
  })

  test("第三层只显示该分组的项", async () => {
    const { app, captured } = await mount(["global", "panel"])
    try {
      captured.run?.()
      await app.waitFor(() => captured.history.length >= 3)
      const options = captured.history[2]?.options ?? []
      expect(options.map((option) => option.value)).toEqual([
        "show",
        "showCacheChart",
        "showCacheLog",
        "showSummaries",
      ])
    } finally {
      app.renderer.destroy()
    }
  })

  test("选择 showCacheChart 会翻转设置", async () => {
    const { app, captured, settings } = await mount(["global", "panel", "showCacheChart", undefined])
    try {
      captured.run?.()
      await app.waitFor(() => settings().showCacheChart === false)
      expect(settings().showCacheChart).toBe(false)
    } finally {
      app.renderer.destroy()
    }
  })

  test("选择 summaryFormat 会切到 json", async () => {
    const { app, captured, settings } = await mount(["global", "summary", "summaryFormat", "json", undefined])
    try {
      captured.run?.()
      await app.waitFor(() => settings().summaryFormat === "json")
      expect(settings().summaryFormat).toBe("json")
    } finally {
      app.renderer.destroy()
    }
  })

  test("取消第一层时不写设置也不重开", async () => {
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

  test("弹窗型动作只开弹窗，不重开菜单", async () => {
    const { app, captured } = await mount(["global", "compress", "nudge"])
    try {
      captured.run?.()
      await app.waitFor(() => captured.shows === 1)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(captured.selects).toBe(3)
    } finally {
      app.renderer.destroy()
    }
  })

  test("limit 选自定义时只继续开输入框", async () => {
    const { app, captured } = await mount(["global", "compress", "limit", "custom"])
    try {
      captured.run?.()
      await app.waitFor(() => captured.shows === 1)
      await new Promise((resolve) => setTimeout(resolve, 20))
      // 第一层 + 分组 + limit 选择 + limit 自己的选项；自定义输入框已打开，不能再弹菜单。
      expect(captured.selects).toBe(4)
    } finally {
      app.renderer.destroy()
    }
  })

  test("nudge 间隔 0 是合法值，不显示 invalid", async () => {
    const captured: Captured = { answers: [], history: [], selects: 0, shows: 0 }
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
