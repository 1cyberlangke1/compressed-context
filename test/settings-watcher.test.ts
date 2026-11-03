import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"

import { watchConfigFiles } from "../src/compression/settings-watcher.ts"

const cleanup: string[] = []

/** 输入：无；输出：临时工作区目录与其中的配置文件路径。预期：隔离在系统临时目录。 */
async function workspace(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cc-watcher-"))
  cleanup.push(dir)
  const file = join(dir, "compressed-context.json")
  await writeFile(file, "{}", "utf8")
  return { dir, file }
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("watchConfigFiles 配置监听器", () => {
  test("外部直接写入目标文件时触发回调", async () => {
    const { file } = await workspace()
    let calls = 0

    const watcher = watchConfigFiles({
      files: [file],
      debounceMs: 50,
      onChange: () => {
        calls += 1
      },
    })

    try {
      await writeFile(file, JSON.stringify({ triggerPercent: 88 }), "utf8")
      await vi.waitFor(() => {
        expect(calls).toBeGreaterThanOrEqual(1)
      }, { timeout: 2000, interval: 50 })
    } finally {
      watcher.dispose()
    }
  })

  test("本进程标记自己写入时忽略该事件", async () => {
    const { file } = await workspace()
    let calls = 0

    const watcher = watchConfigFiles({
      files: [file],
      debounceMs: 50,
      onChange: () => {
        calls += 1
      },
    })

    try {
      // 标记为本进程写入
      watcher.markSelfSaved(file)
      await writeFile(file, JSON.stringify({ triggerPercent: 85 }), "utf8")
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(calls).toBe(0)
    } finally {
      watcher.dispose()
    }
  })

  test("dispose 后不再接收文件变更", async () => {
    const { file } = await workspace()
    let calls = 0

    const watcher = watchConfigFiles({
      files: [file],
      debounceMs: 50,
      onChange: () => {
        calls += 1
      },
    })

    watcher.dispose()
    await writeFile(file, JSON.stringify({ triggerPercent: 90 }), "utf8")
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(calls).toBe(0)
  })
})
