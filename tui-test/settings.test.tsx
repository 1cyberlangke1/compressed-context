import { testRender } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import type { Context, DialogSelectOptions } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"

import { DEFAULT_SETTINGS, type Settings } from "../src/settings.ts"
import { SettingsCommand } from "../src/tui/settings.tsx"

/** 输入：捕获对象；输出：SettingsCommand 需要的最小上下文。 */
function fakeContext(captured: {
  options?: DialogSelectOptions<string>
  run?: () => void
}): Context {
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
          return Promise.resolve(undefined)
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

describe("SettingsCommand", () => {
  test("打开菜单时按分类分组", async () => {
    const captured: { options?: DialogSelectOptions<string>; run?: () => void } = {}
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
    try {
      await app.waitFor(() => captured.run !== undefined)
      captured.run?.()
      await app.waitFor(() => captured.options !== undefined)
      const options = captured.options?.options ?? []
      expect(options.map((option) => option.value)).toContain("showCacheChart")
      expect(options.map((option) => option.value)).toContain("showCacheLog")
      expect(options.map((option) => option.value)).toContain("showSummaries")
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
})
