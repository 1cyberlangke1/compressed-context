import type { Schema } from "effect"
import type { Plugin } from "@opencode/plugin"
import { describe, expect, it } from "vitest"

import { handleCompactionEvent, reconcileAll } from "../src/compression/events.ts"
import { createStateStore, stateStore } from "../src/compression/state-store.ts"
import { loadState, stateKey, type Block, type StorageLike } from "../src/compression/state.ts"

/** 带 scan 的内存 storage，够 reconcileAll 分页用。 */
type ScanStorage = StorageLike & {
  readonly scan: (options: { prefix: string; limit: number; after?: string }) => Promise<{
    entries: readonly { key: string; value: unknown }[]
    next?: string
  }>
}

/** 输入：初始键值；输出：内存 storage。 */
function memoryStorage(initial: Record<string, unknown> = {}): ScanStorage {
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
    scan: ({ prefix, limit, after }) => {
      const keys = [...values.keys()]
        .filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
        .sort()
      const page = keys.slice(0, limit)
      return Promise.resolve({
        entries: page.map((key) => ({ key, value: values.get(key) })),
        ...(page.length === limit && page.length > 0 ? { next: page[page.length - 1] } : {}),
      })
    },
  }
}

/** 输入：id；输出：最小合法块。 */
function block(id: string): Block {
  return {
    id,
    tier: 1,
    height: 1,
    summary: {
      title: id,
      goal: id,
      constraints: [],
      decisions: [],
      open_items: [],
      files: [],
      facts: [],
      progress: { completed: [], active: [], blocked: [] },
    },
    fromId: `m-${id}`,
    toId: `m-${id}`,
    sourceTokens: 100,
    summaryTokens: 10,
    at: 1,
    order: 1,
  }
}

describe("StateStore", () => {
  it("transact 串行化同一会话的读改写", async () => {
    const storage = memoryStorage()
    const store = createStateStore(storage)
    await store.transact("ses_a", () => ({ next: { blocks: [], attempts: 0 }, result: undefined }))
    await Promise.all(
      Array.from({ length: 5 }, () =>
        store.transact("ses_a", async (state) => {
          await new Promise((resolve) => setTimeout(resolve, 5))
          return {
            next: { ...state, attempts: state.attempts + 1 },
            result: state.attempts,
          }
        }),
      ),
    )
    expect((await store.read("ses_a")).attempts).toBe(5)
  })

  it("不返回 next 时不写回", async () => {
    const storage = memoryStorage()
    const store = createStateStore(storage)
    await expect(store.transact("ses_a", () => ({ result: "ok" }))).resolves.toBe("ok")
    expect(await storage.get(stateKey("ses_a"))).toBeUndefined()
  })

  it("事务抛错不会卡住后续事务", async () => {
    const storage = memoryStorage()
    const store = createStateStore(storage)
    await expect(
      store.transact("ses_a", () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    await expect(store.transact("ses_a", () => ({ result: "after" }))).resolves.toBe("after")
  })

  it("同一 storage 复用同一个 store，不同 storage 互不影响", () => {
    const first = memoryStorage()
    const second = memoryStorage()
    expect(stateStore(first)).toBe(stateStore(first))
    expect(stateStore(first)).not.toBe(stateStore(second))
  })
})

describe("reconcileAll 与 compaction 事件", () => {
  it("reconcileAll 不信任 scan 的旧快照，锁内重新读 state", async () => {
    const storage = memoryStorage()
    await storage.set(
      stateKey("ses_stale"),
      { blocks: [block("b1")], attempts: 0 } as unknown as Schema.Json,
    )
    // scan 返回「还有 pending」的旧快照；真实 state 已经转正为 b1。
    const stale = { blocks: [], pending: block("b2"), attempts: 0 } as unknown as Schema.Json
    const staleStorage: ScanStorage = {
      ...storage,
      scan: ({ prefix, limit, after }) => {
        if (!prefix.startsWith("compression:state:")) return storage.scan({ prefix, limit, ...(after === undefined ? {} : { after }) })
        return Promise.resolve({
          entries: [{ key: stateKey("ses_stale"), value: stale }],
        })
      },
    }
    const ctx = {
      storage: staleStorage,
      location: { directory: "/work" },
      session: {
        get: () => Promise.resolve({ metadata: {}, location: { directory: "/work" } }),
        context: () => Promise.reject(new Error("stale pending must not be reconciled")),
      },
    } as unknown as Plugin.Context

    await reconcileAll(ctx)
    expect((await loadState(storage, "ses_stale")).blocks.map((item) => item.id)).toEqual(["b1"])
  })

  it("同一会话的 state 读取串行执行，已转正块不会被覆盖", async () => {
    const storage = memoryStorage()
    await storage.set(
      stateKey("ses_race"),
      { blocks: [], pending: block("b1"), attempts: 0 } as unknown as Schema.Json,
    )

    let active = 0
    let maxActive = 0
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve
    })

    const ctx = {
      storage,
      location: { directory: "/work" },
      session: {
        get: () => Promise.resolve({ metadata: {}, location: { directory: "/work" } }),
        context: async () => {
          calls += 1
          active += 1
          maxActive = Math.max(maxActive, active)
          if (calls === 1) {
            entered()
            await gate
          }
          active -= 1
          return calls === 1
            ? [{ type: "compaction", status: "completed", summary: "[Compressed conversation section #b1]" }]
            : []
        },
      },
    } as unknown as Plugin.Context

    const event = handleCompactionEvent(ctx, "ended", "ses_race")
    await enteredPromise
    const reconcile = reconcileAll(ctx)
    await new Promise((resolve) => setTimeout(resolve, 10))
    release()
    await Promise.all([event, reconcile])

    expect(maxActive).toBe(1)
    expect((await loadState(storage, "ses_race")).blocks.map((item) => item.id)).toEqual(["b1"])
  })

  it("reconcileAll 只对账本实例 directory 的 pending，不碰别的目录", async () => {
    const storage = memoryStorage({
      [stateKey("ses_mine")]: { blocks: [], pending: block("b_mine"), attempts: 0 },
      [stateKey("ses_other")]: { blocks: [], pending: block("b_other"), attempts: 0 },
    })
    const calls: string[] = []
    const ctx = {
      storage,
      location: { directory: "/a" },
      session: {
        get: ({ sessionID }: { sessionID: string }) =>
          Promise.resolve({
            location: { directory: sessionID === "ses_mine" ? "/a" : "/b" },
          }),
        context: ({ sessionID }: { sessionID: string }) => {
          calls.push(sessionID)
          return Promise.resolve(
            sessionID === "ses_mine"
              ? [{ type: "compaction", status: "completed", summary: "[Compressed conversation section #b_mine]" }]
              : [],
          )
        },
      },
    } as unknown as Plugin.Context

    await reconcileAll(ctx)

    expect(calls).toEqual(["ses_mine"])
    expect((await loadState(storage, "ses_mine")).blocks.map((item) => item.id)).toEqual(["b_mine"])
    expect((await loadState(storage, "ses_other")).pending?.id).toBe("b_other")
  })

  it("reconcileAll 同目录不同 workspaceID 的 pending 也跳过", async () => {
    const storage = memoryStorage({
      [stateKey("ses_mine")]: { blocks: [], pending: block("b_mine"), attempts: 0 },
      [stateKey("ses_other")]: { blocks: [], pending: block("b_other"), attempts: 0 },
    })
    const calls: string[] = []
    const ctx = {
      storage,
      location: { directory: "/work", workspaceID: "ws_a" },
      session: {
        get: ({ sessionID }: { sessionID: string }) =>
          Promise.resolve({
            location: { directory: "/work", workspaceID: sessionID === "ses_mine" ? "ws_a" : "ws_b" },
          }),
        context: ({ sessionID }: { sessionID: string }) => {
          calls.push(sessionID)
          return Promise.resolve(
            sessionID === "ses_mine"
              ? [{ type: "compaction", status: "completed", summary: "[Compressed conversation section #b_mine]" }]
              : [],
          )
        },
      },
    } as unknown as Plugin.Context

    await reconcileAll(ctx)

    expect(calls).toEqual(["ses_mine"])
    expect((await loadState(storage, "ses_mine")).blocks.map((item) => item.id)).toEqual(["b_mine"])
    expect((await loadState(storage, "ses_other")).pending?.id).toBe("b_other")
  })

  it("reconcileAll 瞬时查询失败时跳过，不丢 pending", async () => {
    // 缺失会话由文件末尾的结构化 Session.NotFoundError 用例覆盖；
    // 这里只验证瞬时错误不删数据、也不替它做对账。
    const storage = memoryStorage({
      [stateKey("ses_error")]: { blocks: [], pending: block("b2"), attempts: 0 },
    })
    let contextCalls = 0
    const ctx = {
      storage,
      location: { directory: "/work" },
      session: {
        get: () => Promise.reject(new Error("transient")),
        context: () => {
          contextCalls += 1
          return Promise.resolve([])
        },
      },
    } as unknown as Plugin.Context

    await reconcileAll(ctx)

    expect(contextCalls).toBe(0)
    expect((await loadState(storage, "ses_error")).pending?.id).toBe("b2")
  })

  it("错误文案含 not found 但结构不明确时不删会话状态", async () => {
    const storage = memoryStorage({ [stateKey("ses_orphan")]: { blocks: [], attempts: 0 } })
    const ctx = {
      storage,
      location: { directory: "/work" },
      session: { get: () => Promise.reject(new Error("session not found")) },
    } as unknown as Plugin.Context

    await reconcileAll(ctx)

    expect(await storage.get(stateKey("ses_orphan"))).toBeDefined()
  })

  it("结构化 Session.NotFoundError 才清理孤儿状态", async () => {
    const storage = memoryStorage({ [stateKey("ses_gone")]: { blocks: [], attempts: 0 } })
    const ctx = {
      storage,
      location: { directory: "/work" },
      session: {
        get: () =>
          Promise.reject(Object.assign(new Error("session not found"), { _tag: "Session.NotFoundError" })),
      },
    } as unknown as Plugin.Context

    await reconcileAll(ctx)

    expect(await storage.get(stateKey("ses_gone"))).toBeUndefined()
  })
})
