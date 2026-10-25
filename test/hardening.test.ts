import type { Schema } from "effect"
import type { Plugin } from "@opencode/plugin"
import { describe, expect, it, vi } from "vitest"

import { resolveLimit } from "../src/compression/auto.ts"
import { clearDeletedSessions, isSessionDeleted, markSessionDeleted } from "../src/compression/deleted-sessions.ts"
import { createStateStore } from "../src/compression/state-store.ts"
import { updateSessionMetadata } from "../src/compression/session-metadata.ts"
import { stateKey, type State, type StorageLike } from "../src/compression/state.ts"

/** 输入：初始键值；输出：共享同一份 Map 的内存 storage。 */
function memoryStorage(initial: Record<string, unknown> = {}): StorageLike {
  const values = new Map<string, Schema.Json>(Object.entries(initial) as [string, Schema.Json][])
  return {
    get: (key) => Promise.resolve(values.get(key)),
    set: (key, value) => {
      values.set(key, value)
      return Promise.resolve()
    },
    remove: (key) => {
      values.delete(key)
      return Promise.resolve()
    },
  }
}

describe("窗口缓存按会话隔离", () => {
  it("知道会话时不写全局 window:last / window:effective", async () => {
    const storage = memoryStorage()
    const ctx = {
      storage,
      location: { directory: "/work" },
      model: {
        list: () => Promise.resolve({ data: [{ providerID: "p", id: "m", limit: { context: 200_000 } }] }),
      },
    } as unknown as Plugin.Context

    const limit = await resolveLimit(ctx, { providerID: "p", id: "m" }, 100_000, "ses_a")

    expect(limit).toBe(100_000)
    expect(await storage.get("window:last")).toBeUndefined()
    expect(await storage.get("window:effective")).toBeUndefined()
    expect(await storage.get("window:last:ses_a")).toBe(200_000)
    expect(await storage.get("window:effective:ses_a")).toBe(100_000)
    // 模型原生窗口是模型属性，仍然共享。
    expect(await storage.get("window:p/m")).toBe(200_000)
  })
})

describe("会话 metadata 串行合并", () => {
  it("并发写入不会互相覆盖键", async () => {
    let metadata: Record<string, unknown> = {}
    const ctx = {
      session: {
        get: () => Promise.resolve({ metadata }),
        update: ({ metadata: next }: { metadata: Record<string, unknown> }) => {
          metadata = next
          return Promise.resolve()
        },
      },
    } as unknown as Plugin.Context

    await Promise.all([
      updateSessionMetadata(ctx, "ses_a", (current) => ({ ...current, a: 1 })),
      updateSessionMetadata(ctx, "ses_a", (current) => ({ ...current, b: 2 })),
      updateSessionMetadata(ctx, "ses_a", (current) => ({ ...current, c: 3 })),
    ])

    expect(metadata).toEqual({ a: 1, b: 2, c: 3 })
  })
})

describe("状态锁跨 StateStore 共享", () => {
  it("两个 storage 包装对象写同一 key 时仍然串行", async () => {
    const shared = memoryStorage()
    const first = createStateStore(shared)
    const second = createStateStore({ ...shared })
    const base: State = { blocks: [], attempts: 0 }

    await Promise.all([
      first.transact("ses_a", async (state) => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return { next: { ...state, attempts: state.attempts + 1 }, result: undefined }
      }),
      second.transact("ses_a", (state) => ({
        next: { ...state, attempts: state.attempts + 1 },
        result: undefined,
      })),
    ])

    const saved = await shared.get(stateKey("ses_a"))
    expect((saved as unknown as State).attempts).toBe(2)
    expect(base.attempts).toBe(0)
  })
})

describe("已删除会话墓碑有上限", () => {
  it("超过上限时淘汰最老的墓碑，集合不会无限增长", () => {
    clearDeletedSessions()
    for (let index = 0; index < 5_100; index += 1) markSessionDeleted(`ses_${index.toString()}`)
    expect(isSessionDeleted("ses_5099")).toBe(true)
    expect(isSessionDeleted("ses_0")).toBe(false)
  })

  it("墓碑超过保留期自动失效，避免永久挡住写入", () => {
    clearDeletedSessions()
    vi.useFakeTimers()
    markSessionDeleted("ses_stale")
    vi.advanceTimersByTime(25 * 60 * 60 * 1000)
    expect(isSessionDeleted("ses_stale")).toBe(false)
    vi.useRealTimers()
  })
})
