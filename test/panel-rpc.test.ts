import type { Plugin } from "@opencode/plugin"
import type { Schema } from "effect"
import { describe, expect, it } from "vitest"

import type { CacheMessage } from "../src/cache.ts"
import type { Block } from "../src/compression/state.ts"
import { saveState } from "../src/compression/state.ts"
import type { StorageLike } from "../src/compression/state.ts"
import { registerSettingsRpc } from "../src/compression/settings-rpc.ts"
import type { SummaryFields } from "../src/compression/schema.ts"

/** 输入：无；输出：内存 storage 替身。 */
function createStorage(): StorageLike {
  const data = new Map<string, unknown>()
  return {
    get(key) {
      return Promise.resolve(data.get(key) as Schema.Json | undefined)
    },
    set(key, value) {
      data.set(key, value)
      return Promise.resolve()
    },
    remove(key) {
      data.delete(key)
      return Promise.resolve()
    },
  }
}

/** 输入：标题；输出：最小合法摘要。 */
function summary(title: string): SummaryFields {
  return {
    title,
    goal: title,
    constraints: [],
    decisions: [],
    open_items: [],
    files: [],
    facts: [],
    progress: { completed: [], active: [], blocked: [] },
  }
}

/** 输入：id + 等级 + 顺序 + 可选合并来源；输出：块。 */
function block(
  id: string,
  tier: Block["tier"],
  order: number,
  sourceBlockIds?: readonly string[],
): Block {
  return {
    id,
    tier,
    summary: summary(`title-${id}`),
    fromId: "m1",
    toId: "m2",
    tokensBefore: 100,
    tokensAfter: 10,
    at: order,
    order,
    ...(sourceBlockIds === undefined ? {} : { sourceBlockIds }),
  }
}

/** 输入：id；输出：带 usage 的 assistant 消息。 */
function message(id: string): CacheMessage {
  return {
    id,
    type: "assistant",
    time: { created: 1 },
    tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 90, write: 0 } },
  }
}

/** 输入：storage + 每个会话的消息；输出：捕获的 RPC 处理器。 */
async function createHandlers(
  storage: StorageLike,
  messagesBySession: ReadonlyMap<string, readonly CacheMessage[]>,
): Promise<Record<string, (input: unknown) => Promise<unknown>>> {
  const handlers: Record<string, (input: unknown) => Promise<unknown>> = {}
  const ctx = {
    storage,
    session: {
      get: () => Promise.resolve({ metadata: {} }),
      context: ({ sessionID }: { sessionID: string }) =>
        Promise.resolve(messagesBySession.get(sessionID) ?? []),
    },
    rpc: {
      register: (
        _definition: unknown,
        value: Record<string, (input: unknown) => Promise<unknown>>,
      ) => {
        Object.assign(handlers, value)
        return Promise.resolve({ dispose: () => Promise.resolve() })
      },
    },
  } as unknown as Plugin.Context
  await registerSettingsRpc(ctx)
  return handlers
}

describe("blocksGet", () => {
  it("只返回 active 链，并带上渲染好的 markdown", async () => {
    const storage = createStorage()
    const b1 = block("b1", 1, 1)
    const b2 = block("b2", 1, 2)
    const merged = block("b3", 2, 1, ["b1", "b2"])
    await saveState(storage, "ses_a", { v: 1, blocks: [b1, b2, merged], attempts: 0 })
    const handlers = await createHandlers(storage, new Map())
    const result = (await handlers["blocksGet"]?.({ sessionID: "ses_a" })) as {
      blocks: readonly { id: string; tier: number; sourceBlockIds?: readonly string[]; body: string }[]
    }
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0]?.id).toBe("b3")
    expect(result.blocks[0]?.tier).toBe(2)
    expect(result.blocks[0]?.sourceBlockIds).toEqual(["b1", "b2"])
    expect(result.blocks[0]?.body).toContain("## Goal")
    expect(result.blocks[0]?.body).toContain("title-b3")
  })

  it("会话没有块时返回空数组", async () => {
    const storage = createStorage()
    const handlers = await createHandlers(storage, new Map())
    const result = (await handlers["blocksGet"]?.({ sessionID: "ses_missing" })) as {
      blocks: readonly unknown[]
    }
    expect(result.blocks).toEqual([])
  })
})

describe("cacheHistoryGet", () => {
  it("读取前补写当前上下文，并按会话隔离", async () => {
    const storage = createStorage()
    const handlers = await createHandlers(
      storage,
      new Map([
        ["ses_a", [message("m1")]],
        ["ses_b", [message("m2")]],
      ]),
    )
    const result = (await handlers["cacheHistoryGet"]?.({ sessionID: "ses_a" })) as {
      samples: readonly { messageID: string; hitRate: number }[]
    }
    expect(result.samples).toHaveLength(1)
    expect(result.samples[0]?.messageID).toBe("m1")
    expect(result.samples[0]?.hitRate).toBe(90)

    const other = (await handlers["cacheHistoryGet"]?.({ sessionID: "ses_b" })) as {
      samples: readonly { messageID: string }[]
    }
    expect(other.samples).toHaveLength(1)
    expect(other.samples[0]?.messageID).toBe("m2")
  })
})
