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
  shows: number
  readonly sent: Settings[]
  readonly toasts: string[]
}

const MODELS = [
  { providerID: "google", modelID: "gemini-3-pro", name: "Gemini 3 Pro", limit: { context: 1_000_000, output: 4096 } },
  { providerID: "openrouter", modelID: "gemini-3-pro", name: "Gemini 3 Pro (OR)", limit: { context: 1_000_000, output: 4096 } },
]

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
        show: () => {
          captured.shows += 1
        },
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
    data: { location: { model: { list: () => MODELS } } },
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
 * 输入：脚本化的 select 返回值 + 可选初始设置。
 * 输出：渲染好的 app + 记录器。
 * 预期：updateSettings 与 main.tsx 用同一套 applySettingsMutation / snapshotSettings。
 */
async function mount(answers: unknown[], initial?: Partial<Settings>) {
  const captured: Captured = { answers, selects: 0, shows: 0, sent: [], toasts: [] }
  const context = fakeContext(captured)
  const [settings, setSettings] = createStore<Settings>({
    ...DEFAULT_SETTINGS,
    models: {},
    ...initial,
  })
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
  return { app, captured, settings }
}

describe("按模型设置的 TUI 路径", () => {
  test("修改精确模型的阈值", async () => {
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

  test("恢复继承会删掉整个模型键", async () => {
    const { app, captured } = await mount(
      ["models", "current", { kind: "field", field: "triggerPercent" }, "inherit", undefined, undefined],
      { models: { "google/gemini-3-pro": { triggerPercent: 85 } } },
    )
    try {
      captured.run?.()
      await Bun.sleep(150)
      expect(captured.sent.at(-1)?.models["google/gemini-3-pro"]).toBeUndefined()
    } finally {
      app.renderer.destroy()
    }
  })

  test("删除这条设置会清掉覆盖", async () => {
    const { app, captured } = await mount(
      ["models", "current", { kind: "delete" }, undefined],
      { models: { "google/gemini-3-pro": { triggerPercent: 85 } } },
    )
    try {
      captured.run?.()
      await Bun.sleep(150)
      expect(captured.sent.at(-1)?.models["google/gemini-3-pro"]).toBeUndefined()
    } finally {
      app.renderer.destroy()
    }
  })

  test("选「同名模型」后写入不带提供商的键", async () => {
    const { app, captured } = await mount([
      "models",
      "overrides",
      "__add",
      { key: "gemini-3-pro" },
      "name",
      { kind: "field", field: "triggerPercent" },
      90,
      undefined,
      undefined,
    ])
    try {
      captured.run?.()
      await Bun.sleep(150)
      expect(captured.sent.at(-1)?.models["gemini-3-pro"]?.triggerPercent).toBe(90)
    } finally {
      app.renderer.destroy()
    }
  })

  test("同名模型改选精确提供商时写到 provider/模型 键", async () => {
    const { app, captured } = await mount([
      "models",
      "overrides",
      "__add",
      { key: "gemini-3-pro" },
      "openrouter/gemini-3-pro",
      { kind: "field", field: "triggerPercent" },
      90,
      undefined,
      undefined,
    ])
    try {
      captured.run?.()
      await Bun.sleep(150)
      expect(captured.sent.at(-1)?.models["openrouter/gemini-3-pro"]?.triggerPercent).toBe(90)
    } finally {
      app.renderer.destroy()
    }
  })

  test("点自定义会打开输入弹窗，且不会立刻被编辑屏顶掉", async () => {
    const { app, captured } = await mount([
      "models",
      "current",
      { kind: "field", field: "triggerPercent" },
      "custom",
    ])
    try {
      captured.run?.()
      await Bun.sleep(150)
      expect(captured.shows).toBe(1)
      // 选完自定义后编辑屏不能再弹一次，否则会把输入框盖掉。
      expect(captured.selects).toBe(4)
    } finally {
      app.renderer.destroy()
    }
  })

  test("点自定义走到「全部摘要上限」时也是输入弹窗", async () => {
    const { app, captured } = await mount([
      "models",
      "current",
      { kind: "field", field: "summaryTotalPercent" },
      "custom",
    ])
    try {
      captured.run?.()
      await Bun.sleep(150)
      expect(captured.shows).toBe(1)
      expect(captured.selects).toBe(4)
    } finally {
      app.renderer.destroy()
    }
  })
})
