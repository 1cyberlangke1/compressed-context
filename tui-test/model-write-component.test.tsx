import { testRender } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import type { Context, DialogSelectOptions } from "@opencode/plugin/tui/context"
import { createStore, reconcile } from "solid-js/store"

import { DEFAULT_SETTINGS, type Settings } from "../src/shared/settings.ts"
import { applySettingsMutation, snapshotSettings } from "../src/tui/settings-draft.ts"
import { SettingsCommand } from "../src/tui/settings.tsx"

interface Captured {
  run?: () => void
  readonly answers: unknown[]
  selects: number
  readonly sent: Settings[]
  readonly toasts: string[]
}

/** 输入：记录器；输出：SettingsCommand 需要的最小上下文。 */
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
      layer: (factory: () => { commands?: readonly { run: () => void }[] }) => {
        const run = factory().commands?.[0]?.run
        if (run !== undefined) captured.run = run
        return () => {}
      },
    },
    ui: {
      dialog: {
        select: (_options: DialogSelectOptions<unknown>) => {
          captured.selects += 1
          return Promise.resolve(captured.answers.shift())
        },
        show: () => {},
        clear: () => {},
      },
      router: { current: () => ({ type: "session", sessionID: "ses_a" }) },
      model: { current: () => ({ providerID: "google", modelID: "gemini-3-pro" }) },
      toast: {
        show: (options: { message: string }) => {
          captured.toasts.push(options.message)
        },
      },
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
    client: {
      rpc: () => ({
        settingsGet: () => Promise.resolve({ ...DEFAULT_SETTINGS, resolvedWindow: 1_000_000 }),
        settingsSet: (input: Settings) => {
          captured.sent.push(input)
          return Promise.resolve({ ok: true })
        },
      }),
    },
  } as unknown as Context
}

/**
 * 输入：脚本化的 select 返回值。
 * 输出：渲染好的 app + 记录器。
 * 预期：updateSettings 与 main.tsx 用同一套 applySettingsMutation / snapshotSettings 实现。
 */
async function mount(answers: unknown[]) {
  const captured: Captured = { answers, selects: 0, sent: [], toasts: [] }
  const context = fakeContext(captured)
  const [settings, setSettings] = createStore<Settings>({ ...DEFAULT_SETTINGS, models: {} })
  const updateSettings = async (mutation: (draft: Settings) => void): Promise<void> => {
    const previous = snapshotSettings(settings)
    const next = applySettingsMutation(settings, mutation)
    setSettings(reconcile(next))
    const result = await context.client.rpc({} as never).settingsSet(next)
    if (!result.ok) {
      setSettings(reconcile(previous))
      captured.toasts.push("save failed")
    }
  }
  const app = await testRender(
    () => <SettingsCommand context={context} settings={settings} updateSettings={updateSettings} />,
    { width: 40, height: 20 },
  )
  app.renderer.start()
  await app.waitFor(() => captured.run !== undefined)
  return { app, captured }
}

describe("按模型设置的写入", () => {
  test("编辑阈值后 payload.models 必须带上覆盖", async () => {
    const { app, captured } = await mount([
      "models",
      "current",
      { kind: "field", field: "triggerPercent" },
      85,
      undefined,
      undefined,
    ])
    try {
      captured.run?.()
      await Bun.sleep(150)
      expect(captured.sent.at(-1)?.models["google/gemini-3-pro"]?.triggerPercent).toBe(85)
    } finally {
      app.renderer.destroy()
    }
  })
})
