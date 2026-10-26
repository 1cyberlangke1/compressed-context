import { testRender } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import type {
  Context,
  DialogAlertOptions,
  DialogConfirmOptions,
  DialogSelectOptions,
} from "@opencode/plugin/tui/context"
import { RGBA } from "@opentui/core"
import { createSignal } from "solid-js"

import { resolveMessages } from "../src/i18n/index.ts"
import { DEFAULT_SETTINGS, type Settings } from "../src/shared/settings.ts"
import { PLUGIN_VERSION } from "../src/shared/version.ts"
import {
  updateCommandLine,
  type UpdateCheckResult,
  type UpdateProgress,
  type UpdateStartResult,
} from "../src/shared/update.ts"
import { SettingsCommand } from "../src/tui/settings.tsx"
import type { UpdateDeps } from "../src/tui/update-menu.tsx"

type ToastCall = {
  readonly title?: string
  readonly message: string
  readonly variant?: string
  readonly duration?: number
}

type Captured = {
  run?: () => void
  readonly answers: (string | undefined)[]
  readonly confirmAnswers: (boolean | undefined)[]
  readonly confirms: DialogConfirmOptions[]
  readonly history: DialogSelectOptions<string>[]
  readonly alerts: DialogAlertOptions[]
  readonly toasts: ToastCall[]
  shows: number
  clears: number
}

const COLORS = {
  warning: RGBA.fromInts(255, 193, 7, 255),
  error: RGBA.fromInts(255, 0, 0, 255),
}

/** 输入：捕获对象；输出：SettingsCommand 需要的最小真实形状上下文。 */
function fakeContext(captured: Captured): Context {
  return {
    keymap: {
      layer: (factory: () => { commands: readonly { run: () => void }[] }) => {
        captured.run = factory().commands[0]?.run
        return () => {}
      },
    },
    theme: {
      text: {
        base: COLORS.warning,
        muted: COLORS.error,
        feedback: {
          warning: { base: COLORS.warning },
          error: { base: COLORS.error },
          success: { base: COLORS.warning },
          info: { base: COLORS.error },
        },
      },
    },
    ui: {
      dialog: {
        alert: (options: DialogAlertOptions) => {
          captured.alerts.push(options)
          return Promise.resolve()
        },
        confirm: (options: DialogConfirmOptions) => {
          captured.confirms.push(options)
          return Promise.resolve(captured.confirmAnswers.shift())
        },
        select: (options: DialogSelectOptions<string>) => {
          captured.history.push(options)
          return Promise.resolve(captured.answers.shift())
        },
        show: () => {
          captured.shows += 1
        },
        clear: () => {
          captured.clears += 1
        },
      },
      toast: {
        show: (call: ToastCall) => {
          captured.toasts.push(call)
        },
      },
      router: { current: () => ({ type: "session", sessionID: "ses_a" }) },
      model: { current: () => ({ providerID: "google", modelID: "gemini-3-pro" }) },
    },
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

/** 输入：菜单返回序列、确认序列、语言与更新依赖；输出：渲染结果与捕获对象。 */
async function mount(options: {
  readonly answers: (string | undefined)[]
  readonly confirmAnswers?: (boolean | undefined)[]
  readonly locale: "zh" | "en"
  readonly deps: UpdateDeps
}) {
  const captured: Captured = {
    answers: options.answers,
    confirmAnswers: [...(options.confirmAnswers ?? [])],
    confirms: [],
    history: [],
    alerts: [],
    toasts: [],
    shows: 0,
    clears: 0,
  }
  const context = fakeContext(captured)
  const [settings, setSettings] = createSignal<Settings>({
    ...DEFAULT_SETTINGS,
    locale: options.locale,
  })
  const updateSettings = async (mutation: (draft: Settings) => void): Promise<void> => {
    setSettings((previous) => {
      const draft = { ...previous }
      mutation(draft)
      return draft
    })
  }
  const app = await testRender(
    () => (
      <SettingsCommand
        context={context}
        settings={settings()}
        updateSettings={updateSettings}
        updateDeps={options.deps}
      />
    ),
    { width: 80, height: 30 },
  )
  app.renderer.start()
  await app.waitFor(() => captured.run !== undefined)
  return { app, captured }
}

/** 输入：检查结果与运行函数；输出：更新依赖。 */
function depsFor(
  check: UpdateCheckResult | (() => Promise<UpdateCheckResult>),
  run: UpdateDeps["run"] = () => Promise.resolve({ ok: true, command: updateCommandLine() }),
): UpdateDeps {
  return {
    check: typeof check === "function" ? check : () => Promise.resolve(check),
    run,
  }
}

const NEW_VERSION: UpdateCheckResult = {
  kind: "update-available",
  currentVersion: PLUGIN_VERSION,
  latestVersion: "9.9.9",
}

const MAIN_MENU_VALUES = [
  "defaults",
  "models",
  "summary",
  "switches",
  "decompress",
  "interface",
  "update",
] as const

describe("更新入口", () => {
  test("主菜单标题直接显示当前版本", async () => {
    const copy = resolveMessages("zh")
    const { app, captured } = await mount({
      answers: [undefined],
      locale: "zh",
      deps: depsFor(NEW_VERSION),
    })
    try {
      captured.run?.()
      await app.waitFor(() => captured.history.length >= 1)

      const options = captured.history[0]?.options ?? []
      expect(options.map((option) => option.value)).toEqual([...MAIN_MENU_VALUES])
      expect(options.at(-1)).toMatchObject({
        title: `${copy.update.checkUpdates} v${PLUGIN_VERSION}`,
        value: "update",
      })
      expect(options.at(-1)?.footer).toBeUndefined()
    } finally {
      app.renderer.destroy()
    }
  })

  test("发现新版后确认框显示版本，取消后主菜单保留星标与 warning 色", async () => {
    const copy = resolveMessages("en")
    let starts = 0
    const { app, captured } = await mount({
      answers: ["update", undefined],
      confirmAnswers: [false],
      locale: "en",
      deps: depsFor(NEW_VERSION, () => {
        starts += 1
        return Promise.resolve({ ok: true, command: updateCommandLine() })
      }),
    })
    try {
      captured.run?.()
      await app.waitFor(() => captured.history.length >= 2 && captured.confirms.length >= 1)

      expect(captured.confirms[0]).toMatchObject({
        title: copy.update.title,
        message: copy.update.confirm(PLUGIN_VERSION, "9.9.9"),
        label: { confirm: copy.update.updateNow, cancel: copy.update.cancel },
      })
      expect(starts).toBe(0)
      expect(captured.history[1]?.options.at(-1)).toMatchObject({
        title: `${copy.update.checkUpdates} v${PLUGIN_VERSION} *`,
        value: "update",
        footer: copy.update.latestFooter("9.9.9"),
        footerColor: COLORS.warning,
      })
    } finally {
      app.renderer.destroy()
    }
  })

  test("确认后原地显示进度，成功时关闭进度框并发成功 toast", async () => {
    const copy = resolveMessages("zh")
    let report: UpdateProgress | undefined
    let finish: ((result: UpdateStartResult) => void) | undefined
    let started: (() => void) | undefined
    const runStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const { app, captured } = await mount({
      answers: ["update", undefined],
      confirmAnswers: [true],
      locale: "zh",
      deps: depsFor(
        NEW_VERSION,
        (onProgress) =>
          new Promise((resolve) => {
            report = onProgress
            finish = resolve
            started?.()
          }),
      ),
    })
    try {
      captured.run?.()
      await runStarted

      expect(captured.shows).toBe(1)
      report?.("Downloading compressed-context")
      finish?.({ ok: true, command: updateCommandLine() })
      await app.waitFor(() => captured.toasts.length >= 1 && captured.clears >= 1)

      expect(captured.toasts[0]).toMatchObject({
        title: copy.update.title,
        message: copy.update.succeeded,
        variant: "success",
      })
      expect(captured.toasts[0]?.duration).toBeGreaterThan(5_000)
      expect(captured.alerts).toHaveLength(0)
    } finally {
      app.renderer.destroy()
    }
  })

  test("更新失败时关闭进度框并以 error toast 给出可执行命令", async () => {
    const copy = resolveMessages("en")
    const { app, captured } = await mount({
      answers: ["update", undefined],
      confirmAnswers: [true],
      locale: "en",
      deps: depsFor(NEW_VERSION, async (onProgress) => {
        onProgress("npm exited with code 1")
        return { ok: false, command: updateCommandLine() }
      }),
    })
    try {
      captured.run?.()
      await app.waitFor(() => captured.toasts.length >= 1 && captured.clears >= 1)

      expect(captured.toasts[0]).toMatchObject({
        title: copy.update.title,
        message: `${copy.update.runFailed} ${updateCommandLine()}`,
        variant: "error",
      })
      expect(captured.alerts).toHaveLength(0)
    } finally {
      app.renderer.destroy()
    }
  })

  test("已是最新版本时直接 alert，不弹确认也不运行更新", async () => {
    const copy = resolveMessages("en")
    let starts = 0
    const { app, captured } = await mount({
      answers: ["update", undefined],
      locale: "en",
      deps: depsFor(
        {
          kind: "up-to-date",
          currentVersion: PLUGIN_VERSION,
          latestVersion: PLUGIN_VERSION,
        },
        () => {
          starts += 1
          return Promise.resolve({ ok: true, command: updateCommandLine() })
        },
      ),
    })
    try {
      captured.run?.()
      await app.waitFor(() => captured.history.length >= 2 && captured.alerts.length >= 1)

      expect(captured.alerts[0]).toEqual({
        title: copy.update.title,
        message: copy.update.upToDate,
      })
      expect(captured.confirms).toHaveLength(0)
      expect(starts).toBe(0)
      expect(captured.history[1]?.options.at(-1)).toMatchObject({
        title: `${copy.update.checkUpdates} v${PLUGIN_VERSION}`,
        footer: copy.update.upToDate,
      })
    } finally {
      app.renderer.destroy()
    }
  })

  test("检查失败时兜底为 alert 且不产生未处理拒绝", async () => {
    const copy = resolveMessages("zh")
    const { app, captured } = await mount({
      answers: ["update", undefined],
      locale: "zh",
      deps: depsFor(() => Promise.reject(new Error("network down"))),
    })
    try {
      captured.run?.()
      await app.waitFor(() => captured.history.length >= 2 && captured.alerts.length >= 1)

      expect(captured.alerts[0]).toEqual({
        title: copy.update.title,
        message: copy.update.failed,
      })
      expect(captured.history[1]?.options.at(-1)).toMatchObject({
        title: `${copy.update.checkUpdates} v${PLUGIN_VERSION}`,
        footer: copy.update.failed,
        footerColor: COLORS.error,
      })
    } finally {
      app.renderer.destroy()
    }
  })
})
