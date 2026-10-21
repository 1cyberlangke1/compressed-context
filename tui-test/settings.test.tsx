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
          captured.options = options
          return Promise.resolve(captured.answers.shift())
        },
        clear: () => {},
      },
      router: { current: () => ({ type: "session", sessionID: "ses_a" }) },
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
  const captured: Captured = { answers }
  const context = fakeContext(captured)
  const [settings, setSettings] = createSignal<Settings>({ ...DEFAULT_SETTINGS })
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
      expect([...new Set(options.map((option) => option.category))]).toEqual([
        "压缩",
        "摘要",
        "面板",
        "解压",
        "界面",
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
