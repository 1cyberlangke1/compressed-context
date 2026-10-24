import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { cleanupStaleTempFiles } from "../src/compression/decompress.ts"
import {
  TEMP_FILE_PREFIX,
  createTempFileStore,
} from "../src/compression/temp-files.ts"

/** 输入：无；输出：独立临时目录；预期：测试结束由调用方删除。 */
function tempDirectory(): string {
  return mkdtempSync(join(tmpdir(), "cc-temp-files-test-"))
}

/** 输入：目录；输出：匹配插件前缀的文件名。 */
function tempNames(directory: string): string[] {
  return readdirSync(directory).filter((name) => name.startsWith(TEMP_FILE_PREFIX))
}

/** 输入：路径 + 多少小时前；输出：无；预期：改 mtime，模拟旧文件。 */
function ageFile(path: string, hoursAgo: number): void {
  const seconds = Math.floor(Date.now() / 1000) - hoursAgo * 60 * 60
  utimesSync(path, seconds, seconds)
}

describe("createTempFileStore", () => {
  it("按会话删除，换一个 store 实例也能删掉同一个会话的文件", () => {
    const directory = tempDirectory()
    try {
      const writer = createTempFileStore({ directory })
      const first = writer.writeText("ses_a", "b1", "A")
      const second = writer.writeText("ses_b", "b2", "B")
      const reader = createTempFileStore({ directory })
      expect(reader.deleteSession("ses_a")).toBe(1)
      expect(existsSync(first)).toBe(false)
      expect(existsSync(second)).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("sweep 只删超过保留期的文件，不碰无关文件", () => {
    const directory = tempDirectory()
    try {
      const store = createTempFileStore({ directory, maxAgeMs: 24 * 60 * 60 * 1000 })
      const old = store.writeText("ses_a", "b1", "old")
      const fresh = store.writeText("ses_a", "b2", "fresh")
      const unrelated = join(directory, "other-file.txt")
      writeFileSync(unrelated, "keep")
      ageFile(old, 25)
      ageFile(unrelated, 25)
      expect(store.sweep()).toBe(1)
      expect(existsSync(old)).toBe(false)
      expect(existsSync(fresh)).toBe(true)
      expect(existsSync(unrelated)).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("保留期可配置：1 小时时 2 小时前的文件会被清掉", () => {
    const directory = tempDirectory()
    try {
      const store = createTempFileStore({ directory, maxAgeMs: 60 * 60 * 1000 })
      const old = store.writeText("ses_a", "b1", "old")
      ageFile(old, 2)
      expect(store.sweep()).toBe(1)
      expect(existsSync(old)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("启动清理入口按配置的保留期清理残留文件", () => {
    const directory = tempDirectory()
    try {
      const store = createTempFileStore({ directory })
      const old = store.writeText("ses_a", "b1", "old")
      ageFile(old, 30)
      expect(cleanupStaleTempFiles({ directory, maxAgeMs: 24 * 60 * 60 * 1000 })).toBe(1)
      expect(existsSync(old)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("写入后按 cap 删最老，只保留最新的 N 个", () => {
    const directory = tempDirectory()
    try {
      const store = createTempFileStore({ directory, cap: 2 })
      const oldest = store.writeText("ses_a", "b1", "oldest")
      const middle = store.writeText("ses_a", "b2", "middle")
      ageFile(oldest, 3)
      ageFile(middle, 2)
      const fresh = store.writeText("ses_a", "b3", "fresh")
      expect(tempNames(directory)).toHaveLength(2)
      expect(existsSync(oldest)).toBe(false)
      expect(existsSync(middle)).toBe(true)
      expect(existsSync(fresh)).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("cap 只淘汰同一会话的文件，不删别的会话", () => {
    const directory = tempDirectory()
    try {
      const store = createTempFileStore({ directory, cap: 1 })
      const other = store.writeText("ses_b", "b1", "keep me")
      ageFile(other, 5)
      store.writeText("ses_a", "b1", "a1")
      const newest = store.writeText("ses_a", "b2", "a2")
      expect(existsSync(other)).toBe(true)
      expect(existsSync(newest)).toBe(true)
      expect(tempNames(directory)).toHaveLength(2)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
