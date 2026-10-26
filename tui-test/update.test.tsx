import { testRender } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import type { Context, DialogSelectOptions } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"

import { resolveMessages } from "../src/i18n/index.ts"
import { DEFAULT_SETTINGS, type Settings } from "../src/shared/settings.ts"
import { PLUGIN_PACKAGE, PLUGIN_VERSION } from "../src/shared/version.ts"
import {
  startUpdate,
  updateCommandLine,
  type SpawnLike,
  type SpawnedProcess,
  type UpdateCheckResult,
} from "../src/shared/update.ts"
import { SettingsCommand } from "../src/tui/settings.tsx"
import type { UpdateDeps } from "../src/tui/update-menu.ts"

type ToastCall = {
  readonly message: string
  readonly variant?: string
}

interface Captured {
  run?: () => void
  readonly answers: (string | undefined)[]
  /** 每次 select 的选项快照，按调用顺序；用于断言设置菜单与更新菜单。 */
  readonly history: DialogSelectOptions<string>[]
  /** select 调用次数。 */
  selects: number
  /** updateSettings 调用次数；用于确认更新流程不持久化设置。 */
  updateSettingsCalls: number
  readonly toasts: ToastCall[]
}

/** 输入：捕获对象；输出：SettingsCommand 需要的最小上下文。 */
function fakeContext(captured: Captured): Context {
  return {
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
          captured.history.push(options)
          return Promise.resolve(captured.answers.shift())
        },
        show: () => {},
        clear: () => {},
      },
      toast: {
        show: (call: ToastCall) => {
          captured.toasts.push(call)
        },
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

/** 输入：每次 select 的返回值、语言与更新依赖；输出：渲染好的 app + 捕获对象。 */
async function mount(options: {
  readonly answers: (string | undefined)[]
  readonly locale: "zh" | "en"
  readonly deps?: UpdateDeps
}) {
  const captured: Captured = {
    answers: options.answers,
    history: [],
    selects: 0,
    updateSettingsCalls: 0,
    toasts: [],
  }
  const context = fakeContext(captured)
  const [settings, setSettings] = createSignal<Settings>({
    ...DEFAULT_SETTINGS,
    locale: options.locale,
  })
  const updateSettings = async (mutation: (draft: Settings) => void): Promise<void> => {
    captured.updateSettingsCalls += 1
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
        {...(options.deps === undefined ? {} : { updateDeps: options.deps })}
      />
    ),
    { width: 60, height: 24 },
  )
  app.renderer.start()
  await app.waitFor(() => captured.run !== undefined)
  return { app, captured }
}

/** 输入：spawn 事件类型；输出：记录命令并触发该事件的假 spawn。 */
function fakeSpawn(event: "spawn" | "error"): {
  readonly spawnFn: SpawnLike
  readonly calls: { readonly command: string; readonly args: readonly string[] }[]
} {
  const calls: { readonly command: string; readonly args: readonly string[] }[] = []
  const spawnFn = ((command: string, args: readonly string[]) => {
    calls.push({ command, args: [...args] })
    const child: SpawnedProcess = {
      once(name, listener) {
        if (name === event) queueMicrotask(listener)
        return child
      },
      unref: () => undefined,
    }
    return child
  }) as SpawnLike
  return { spawnFn, calls }
}

/** 输入：检查结果与真实启动函数；输出：菜单依赖。 */
function depsFor(
  check: UpdateCheckResult | (() => Promise<UpdateCheckResult>),
  start: UpdateDeps["start"] = () => Promise.resolve({ ok: true, command: updateCommandLine() }),
): UpdateDeps {
  return {
    check: typeof check === "function" ? check : () => Promise.resolve(check),
    start,
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

describe("检查更新入口", () => {
  test("中文主菜单最后一项是检查更新，footer 显示当前版本", async () => {
    const copy = resolveMessages("zh")
    const { app, captured } = await mount({ answers: [undefined], locale: "zh" })
    try {
      captured.run?.()
      await app.waitFor(() => captured.history.length >= 1)

      const options = captured.history[0]?.options ?? []
      expect(options.map((option) => option.value)).toEqual([...MAIN_MENU_VALUES])
      const last = options.at(-1)
      expect(last?.title).toBe(copy.update.checkUpdates)
      expect(last?.value).toBe("update")
      expect(last?.footer).toBe(`v${PLUGIN_VERSION}`)
    } finally {
      app.renderer.destroy()
    }
  })

  test("英文主菜单最后一项是 Check for updates", async () => {
    const copy = resolveMessages("en")
    const { app, captured } = await mount({ answers: [undefined], locale: "en" })
    try {
      captured.run?.()
      await app.waitFor(() => captured.history.length >= 1)

      const last = captured.history[0]?.options.at(-1)
      expect(last?.title).toBe(copy.update.checkUpdates)
      expect(last?.footer).toBe(`v${PLUGIN_VERSION}`)
    } finally {
      app.renderer.destroy()
    }
  })
})

describe("更新结果菜单", () => {
  test("发现新版本时展示当前/最新版本、状态与立即更新", async () => {
    const copy = resolveMessages("zh")
    const { app, captured } = await mount({
      answers: ["update", "close"],
      locale: "zh",
      deps: depsFor(NEW_VERSION),
    })
    try {
      captured.run?.()
      await app.waitFor(() => captured.history.length >= 2)

      const call = captured.history[1]
      expect(call?.title).toBe(copy.update.title)
      expect(call?.options.map((option) => option.value)).toEqual([
        "current",
        "latest",
        "status",
        "update",
        "again",
        "close",
      ])
      expect(call?.options.find((option) => option.value === "current")).toMatchObject({
        title: copy.update.current,
        footer: `v${PLUGIN_VERSION}`,
      })
      expect(call?.options.find((option) => option.value === "latest")).toMatchObject({
        title: copy.update.latest,
        footer: "v9.9.9",
      })
      expect(call?.options.find((option) => option.value === "status")).toMatchObject({
        title: copy.update.available,
      })
      expect(call?.options.filter((option) => ["current", "latest", "status"].includes(String(option.value))).every(
        (option) => option.disabled !== true,
      )).toBe(true)
      expect(call?.options.find((option) => option.value === "update")?.title).toBe(copy.update.updateNow)
      expect(call?.options.find((option) => option.value === "again")?.title).toBe(copy.update.checkAgain)
      expect(call?.options.find((option) => option.value === "close")?.title).toBe(copy.update.close)
    } finally {
      app.renderer.destroy()
    }
  })

  test("已是最新版本时不提供立即更新", async () => {
    const copy = resolveMessages("en")
    const { app, captured } = await mount({
      answers: ["update", "close"],
      locale: "en",
      deps: depsFor({
        kind: "up-to-date",
        currentVersion: PLUGIN_VERSION,
        latestVersion: PLUGIN_VERSION,
      }),
    })
    try {
      captured.run?.()
      await app.waitFor(() => captured.history.length >= 2)

      const call = captured.history[1]
      expect(call?.options.find((option) => option.value === "status")?.title).toBe(copy.update.upToDate)
      expect(call?.options.map((option) => option.value)).not.toContain("update")
      expect(call?.options.map((option) => option.value)).toContain("again")
      expect(call?.options.map((option) => option.value)).toContain("close")
    } finally {
      app.renderer.destroy()
    }
  })

  test("无法检查更新时展示失败态且不提供立即更新", async () => {
    const copy = resolveMessages("zh")
    const { app, captured } = await mount({
      answers: ["update", "close"],
      locale: "zh",
      deps: depsFor({ kind: "failed", reason: "network" }),
    })
    try {
      captured.run?.()
      await app.waitFor(() => captured.history.length >= 2)

      const call = captured.history[1]
      expect(call?.title).toBe(copy.update.title)
      expect(call?.options.find((option) => option.value === "status")?.title).toBe(copy.update.failed)
      expect(call?.options.map((option) => option.value)).not.toContain("update")
      expect(call?.options.find((option) => option.value === "again")?.title).toBe(copy.update.checkAgain)
      expect(call?.options.find((option) => option.value === "close")?.title).toBe(copy.update.close)
    } finally {
      app.renderer.destroy()
    }
  })

  test("重新检查会再次请求 registry", async () => {
    const copy = resolveMessages("zh")
    let checks = 0
    const { app, captured } = await mount({
      answers: ["update", "again", "close"],
      locale: "zh",
      deps: depsFor(async () => {
        checks += 1
        return NEW_VERSION
      }),
    })
    try {
      captured.run?.()
      await app.waitFor(() => checks === 2 && captured.history.length >= 3)

      expect(captured.history[1]?.title).toBe(copy.update.title)
      expect(captured.history[2]?.title).toBe(copy.update.title)
      expect(captured.history[2]?.options.map((option) => option.value)).toEqual(
        captured.history[1]?.options.map((option) => option.value),
      )
    } finally {
      app.renderer.destroy()
    }
  })

  test("立即更新调用固定命令并提示重启", async () => {
    const copy = resolveMessages("zh")
    const fake = fakeSpawn("spawn")
    const { app, captured } = await mount({
      answers: ["update", "update"],
      locale: "zh",
      deps: depsFor(NEW_VERSION, () => startUpdate({ spawn: fake.spawnFn })),
    })
    try {
      captured.run?.()
      await app.waitFor(() => captured.toasts.length >= 1)

      expect(fake.calls).toEqual([{ command: "opencode", args: ["plugin", "update", PLUGIN_PACKAGE] }])
      expect(captured.toasts[0]).toEqual({ message: copy.update.started, variant: "info" })
    } finally {
      app.renderer.destroy()
    }
  })

  test("更新启动失败时提示失败并给出可执行命令", async () => {
    const copy = resolveMessages("en")
    const fake = fakeSpawn("error")
    const { app, captured } = await mount({
      answers: ["update", "update"],
      locale: "en",
      deps: depsFor(NEW_VERSION, () => startUpdate({ spawn: fake.spawnFn })),
    })
    try {
      captured.run?.()
      await app.waitFor(() => captured.toasts.length >= 1)

      expect(captured.toasts[0]?.variant).toBe("error")
      expect(captured.toasts[0]?.message).toContain(copy.update.startFailed)
      expect(captured.toasts[0]?.message).toContain(`opencode plugin update ${PLUGIN_PACKAGE}`)
    } finally {
      app.renderer.destroy()
    }
  })
})
