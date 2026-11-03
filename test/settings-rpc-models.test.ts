import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"

import { registerSettingsRpc } from "../src/compression/settings-rpc.ts"
import { DEFAULT_SETTINGS } from "../src/shared/settings.ts"

const cleanup: string[] = []

/** 输入：无；输出：临时目录 + 配置文件路径。预期：隔离在系统临时目录里。 */
async function workspace(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cc-rpc-"))
  cleanup.push(dir)
  return { dir, file: join(dir, "compressed-context.json") }
}

/** 输入：TUI 上下文最小字段；输出：被 registerSettingsRpc 注册的 handlers。 */
function fakeContext(dir: string) {
  const handlers: Record<string, (input: unknown) => Promise<unknown>> = {}
  const emitted: { readonly name: string; readonly data: unknown }[] = []
  return {
    handlers,
    emitted,
    ctx: {
      location: { directory: dir },
      storage: { get: () => Promise.resolve(undefined), set: () => Promise.resolve(), remove: () => Promise.resolve() },
      rpc: {
        register: (_definition: unknown, registered: typeof handlers) => {
          Object.assign(handlers, registered)
          return Promise.resolve({
            dispose: () => Promise.resolve(),
            events: {
              emit: (name: string, data: unknown) => {
                emitted.push({ name, data })
                return Promise.resolve()
              },
            },
          })
        },
      },
      session: { get: () => Promise.reject(new Error("no session")) },
      model: { list: () => Promise.resolve({ data: [] }) },
    },
  }
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("settingsSet 真实 handler", () => {
  test("带 models 的整份设置能落盘并读回来", async () => {
    const { dir, file } = await workspace()
    const { ctx, handlers } = fakeContext(dir)
    await registerSettingsRpc(ctx as never)

    const input = {
      ...DEFAULT_SETTINGS,
      models: { "google/gemini-3-pro": { triggerPercent: 85 } },
      layers: [file],
    }
    const saved = await handlers["settingsSet"]?.(input)
    expect(saved).toEqual({ ok: true })

    const get = (await handlers["settingsGet"]?.({ layers: [file] })) as {
      models?: Record<string, { triggerPercent?: number }>
    }
    expect(get.models?.["google/gemini-3-pro"]?.triggerPercent).toBe(85)

    const text = await readFile(file, "utf8")
    expect(text).toContain("gemini-3-pro")
  })

  test("外部修改配置文件时通过 RPC 广播 settingsUpdated 事件", async () => {
    const { dir } = await workspace()
    const { mkdir, writeFile } = await import("node:fs/promises")
    const opencodeDir = join(dir, ".opencode")
    await mkdir(opencodeDir, { recursive: true })
    const file = join(opencodeDir, "compressed-context.json")
    await writeFile(file, "{}", "utf8")

    const { ctx, emitted } = fakeContext(dir)
    const handle = await registerSettingsRpc(ctx as never)

    try {
      // 外部进程写入配置
      await writeFile(file, JSON.stringify({ triggerPercent: 88, nudgeGrowthTokens: 40000 }), "utf8")

      await vi.waitFor(
        () => {
          const updated = emitted.find((e) => e.name === "settingsUpdated")
          expect(updated).toBeDefined()
          const data = updated?.data as { triggerPercent?: number; nudgeGrowthTokens?: number }
          expect(data.triggerPercent).toBe(88)
          expect(data.nudgeGrowthTokens).toBe(40000)
        },
        { timeout: 2000, interval: 50 },
      )
    } finally {
      await handle.dispose()
    }
  })
})
