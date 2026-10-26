import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import { maybeAutoCompress } from "../src/compression/auto.ts"
import {
  endCompactionRequest,
  tryBeginCompactionRequest,
} from "../src/compression/inflight.ts"
import type { SummaryFields } from "../src/compression/schema.ts"
import type { MessageLike } from "../src/compression/select.ts"
import { stateKey, type StorageLike } from "../src/compression/state.ts"
import { registerCompressTool } from "../src/compression/tool.ts"

/** 输入：无；输出：内存 storage。预期：所有 key 读写都不落盘。 */
function memoryStorage(): StorageLike {
  const values = new Map<string, Schema.Json>()
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

/**
 * 输入：无；输出：可手动 resolve 的 Promise。
 * 预期：用于把一次工具调用卡在 `session.context`，制造确定性的并发窗口。
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

/** 输入：无；输出：满足最小摘要长度的 JSON 摘要。 */
function summary(): SummaryFields {
  return {
    title: "lock test",
    goal: "x".repeat(260),
    constraints: [],
    decisions: [],
    open_items: [],
    files: [],
    facts: [],
    progress: { completed: [], active: [], blocked: [] },
  }
}

/** 输入：无；输出：可压缩的 OpenCode 会话消息。预期：工具输出总量超过最小源长度。 */
function rawSessionMessages(): readonly unknown[] {
  return [
    { id: "m1", type: "user", text: "hi" },
    {
      id: "m2",
      type: "assistant",
      content: Array.from({ length: 3 }, () => ({
        type: "tool",
        name: "shell",
        state: { status: "completed", content: "x".repeat(6_000) },
      })),
    },
    { id: "m3", type: "user", text: "continue" },
  ]
}

/** 输入：无；输出：足以触发自动压缩的对话流。 */
function autoMessages(): MessageLike[] {
  return [
    { id: "m1", role: "user", content: [{ type: "text", text: "hi" }] },
    {
      id: "m2",
      role: "assistant",
      content: Array.from({ length: 6 }, () => ({
        type: "tool-result",
        name: "shell",
        result: "x".repeat(20_000),
      })),
    },
    { id: "m3", role: "user", content: [{ type: "text", text: "continue" }] },
  ]
}

/** 输入：用量；输出：带真实 usage 的会话历史。预期：没有 compaction，视为存在新 user 输入。 */
function autoContext(usage: number): readonly unknown[] {
  return [
    { type: "user", text: "go" },
    {
      type: "assistant",
      tokens: { input: usage, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      content: [{ type: "text", text: "ok" }],
    },
  ]
}

/** 工具 execute 的最小形状；只取本测试断言的字段。 */
interface CapturedTool {
  readonly execute: (
    input: SummaryFields,
    toolCtx: { sessionID: string },
  ) => Promise<{ output: { block?: string; status: string; error?: string }; content: string }>
}

interface HarnessOptions {
  readonly storage: StorageLike
  readonly directory?: string
  readonly session?: () => Record<string, unknown>
  readonly context?: () => Promise<readonly unknown[]>
  readonly compact?: () => Promise<void>
}

/**
 * 输入：storage + 可选的会话 / 上下文 / compact 替身。
 * 输出：捕获到的工具定义与插件上下文。
 * 预期：session.get 默认返回本实例目录下的主会话；context 默认空历史。
 */
async function harness(options: HarnessOptions): Promise<{
  ctx: Plugin.Context
  tool: () => CapturedTool
}> {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), "cc-compress-lock-"))
  const session =
    options.session ?? (() => ({ location: { directory }, model: { providerID: "fake", id: "model" } }))
  let captured: CapturedTool | undefined
  const ctx = {
    storage: options.storage,
    location: { directory },
    model: {
      list: () =>
        Promise.resolve({
          data: [{ providerID: "fake", id: "model", limit: { context: 50_000 } }],
        }),
    },
    session: {
      get: () => Promise.resolve(session()),
      context: options.context ?? (() => Promise.resolve([])),
      compact: options.compact ?? (() => Promise.resolve()),
    },
    tool: {
      transform: (fn: (tools: { add: (tool: CapturedTool) => void }) => void) => {
        fn({ add: (tool) => (captured = tool) })
        return Promise.resolve({ dispose: () => Promise.resolve() })
      },
      reload: () => Promise.resolve(),
    },
  } as unknown as Plugin.Context
  await registerCompressTool(ctx)
  return {
    ctx,
    tool: () => {
      if (captured === undefined) throw new Error("compress tool was not registered")
      return captured
    },
  }
}

describe("手动 compress 并发锁", () => {
  it("自动压缩已抢到发起权时手动 compress 直接拒绝", async () => {
    const storage = memoryStorage()
    let compacts = 0
    const { tool } = await harness({
      storage,
      context: () => Promise.resolve(rawSessionMessages()),
      compact: () => {
        compacts += 1
        return Promise.resolve()
      },
    })
    const sessionID = "ses_requested_held"
    expect(tryBeginCompactionRequest(sessionID)).toBe(true)
    try {
      const blocked = await tool().execute(summary(), { sessionID })
      expect(blocked.output.status).toBe("error")
      expect(blocked.output.error).toContain("compression already in progress")
      expect(compacts).toBe(0)
    } finally {
      endCompactionRequest(sessionID)
    }

    const queued = await tool().execute(summary(), { sessionID })
    expect(queued.output.status).toBe("queued")
    expect(compacts).toBe(1)
  })

  it("手动 compress 与自动压缩同时发生只调用一次 session.compact", async () => {
    const storage = memoryStorage()
    const gate = deferred<readonly unknown[]>()
    const started = deferred<undefined>()
    const compacts: string[] = []
    let contextCalls = 0
    const { ctx, tool } = await harness({
      storage,
      context: () => {
        contextCalls += 1
        if (contextCalls === 1) {
          started.resolve(undefined)
          return gate.promise
        }
        return Promise.resolve(autoContext(45_000))
      },
      compact: () => {
        compacts.push("compact")
        return Promise.resolve()
      },
    })
    const sessionID = "ses_manual_auto_race"

    const manual = tool().execute(summary(), { sessionID })
    await started.promise
    await maybeAutoCompress({
      ctx,
      sessionID,
      messages: autoMessages(),
      system: [],
      tools: {},
      model: { providerID: "fake", id: "model" },
    })
    // 手动工具已经占住发起权，自动路径必须让位。
    expect(compacts).toHaveLength(0)

    gate.resolve(rawSessionMessages())
    const result = await manual
    expect(result.output.status).toBe("queued")
    expect(compacts).toHaveLength(1)
  })

  it("自动压缩发起失败后释放发起权，手动压缩可以继续", async () => {
    const storage = memoryStorage()
    let contextCalls = 0
    let compacts = 0
    const { ctx, tool } = await harness({
      storage,
      context: () => {
        contextCalls += 1
        return Promise.resolve(contextCalls <= 2 ? autoContext(45_000) : rawSessionMessages())
      },
      compact: () => {
        compacts += 1
        return compacts === 1 ? Promise.reject(new Error("auto boom")) : Promise.resolve()
      },
    })
    const sessionID = "ses_auto_throw"
    await maybeAutoCompress({
      ctx,
      sessionID,
      messages: autoMessages(),
      system: [],
      tools: {},
      model: { providerID: "fake", id: "model" },
    })
    expect(compacts).toBe(1)

    const queued = await tool().execute(summary(), { sessionID })
    expect(queued.output.status).toBe("queued")
    expect(compacts).toBe(2)
  })

  it("同一会话的第二次手动压缩在第一次完成前被拒绝，且不读取上下文", async () => {
    const storage = memoryStorage()
    const gate = deferred<readonly unknown[]>()
    const started = deferred<undefined>()
    let contextCalls = 0
    let compacts = 0
    const { tool } = await harness({
      storage,
      context: () => {
        contextCalls += 1
        if (contextCalls === 1) {
          started.resolve(undefined)
          return gate.promise
        }
        return Promise.reject(new Error("second execute must not read context"))
      },
      compact: () => {
        compacts += 1
        return Promise.resolve()
      },
    })
    const sessionID = "ses_two_manual"

    const first = tool().execute(summary(), { sessionID })
    await started.promise
    const second = await tool().execute(summary(), { sessionID })
    expect(second.output.status).toBe("error")
    expect(second.output.error).toContain("compression already in progress")
    expect(contextCalls).toBe(1)

    gate.resolve(rawSessionMessages())
    const firstResult = await first
    expect(firstResult.output.status).toBe("queued")
    expect(compacts).toBe(1)
  })

  it("不同会话可以各自并发压缩", async () => {
    const storage = memoryStorage()
    const compacts: string[] = []
    const { tool } = await harness({
      storage,
      context: () => Promise.resolve(rawSessionMessages()),
      compact: () => Promise.resolve(),
    })
    const execute = async (sessionID: string): Promise<string> => {
      const result = await tool().execute(summary(), { sessionID })
      compacts.push(sessionID)
      return result.output.status
    }
    const statuses = await Promise.all([execute("ses_parallel_a"), execute("ses_parallel_b")])
    expect(statuses).toEqual(["queued", "queued"])
    expect(compacts.sort()).toEqual(["ses_parallel_a", "ses_parallel_b"])
  })

  it("早退失败后释放发起权，后续正常压缩不被永久阻塞", async () => {
    const storage = memoryStorage()
    let contextCalls = 0
    let compacts = 0
    const { tool } = await harness({
      storage,
      context: () => {
        contextCalls += 1
        return Promise.resolve(contextCalls === 1 ? [] : rawSessionMessages())
      },
      compact: () => {
        compacts += 1
        return Promise.resolve()
      },
    })
    const sessionID = "ses_early_return"
    const empty = await tool().execute(summary(), { sessionID })
    expect(empty.output.error).toContain("nothing to compress")

    const queued = await tool().execute(summary(), { sessionID })
    expect(queued.output.status).toBe("queued")
    expect(compacts).toBe(1)
  })

  it("compact 抛错后释放发起权，清掉残留状态后可以再次压缩", async () => {
    const storage = memoryStorage()
    let compacts = 0
    const { tool } = await harness({
      storage,
      context: () => Promise.resolve(rawSessionMessages()),
      compact: () => {
        compacts += 1
        return compacts === 1 ? Promise.reject(new Error("boom")) : Promise.resolve()
      },
    })
    const sessionID = "ses_compact_throw"
    const failed = await tool().execute(summary(), { sessionID })
    expect(failed.output.error).toContain("failed to start compaction")

    // 工具在失败时保留 pending；清掉它模拟下一轮正常状态。
    await storage.remove(stateKey(sessionID))
    const queued = await tool().execute(summary(), { sessionID })
    expect(queued.output.status).toBe("queued")
    expect(compacts).toBe(2)
  })

  it("子代理会话被拒绝且不占锁", async () => {
    const storage = memoryStorage()
    const directory = mkdtempSync(join(tmpdir(), "cc-compress-subagent-"))
    let parentID: string | undefined = "ses_parent"
    let compacts = 0
    const { tool } = await harness({
      storage,
      directory,
      session: () => ({ location: { directory }, ...(parentID === undefined ? {} : { parentID }) }),
      context: () => Promise.resolve(rawSessionMessages()),
      compact: () => {
        compacts += 1
        return Promise.resolve()
      },
    })
    const sessionID = "ses_subagent_lock"
    const denied = await tool().execute(summary(), { sessionID })
    expect(denied.output.error).toContain("subagent")
    expect(compacts).toBe(0)

    parentID = undefined
    const queued = await tool().execute(summary(), { sessionID })
    expect(queued.output.status).toBe("queued")
    expect(compacts).toBe(1)
  })
})
