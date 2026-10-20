import type { Plugin } from "@opencode/plugin"
import type { Schema } from "effect"
import { describe, expect, it } from "vitest"

import type { SummaryFields } from "../src/compression/schema.ts"
import { saveState, type StorageLike } from "../src/compression/state.ts"
import { registerCompressTool } from "../src/compression/tool.ts"
import type { MessageLike } from "../src/compression/select.ts"

/** 输入：无；输出：内存 storage 替身，并记录读取过的 key。 */
function createStorage(): StorageLike & { readonly reads: string[] } {
  const data = new Map<string, unknown>()
  const reads: string[] = []
  return {
    reads,
    get(key) {
      reads.push(key)
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

/** 输入：文本；输出：可压缩的 user 消息。 */
function message(id: string, text: string): MessageLike {
  return { id, role: "user", content: [{ type: "text", text }] }
}

/** 输入：无；输出：满足最小长度的摘要。 */
function summary(): SummaryFields {
  return {
    title: "tool test",
    goal: "x".repeat(260),
    constraints: [],
    decisions: [],
    open_items: [],
    files: [],
    facts: [],
    progress: { completed: [], active: [], blocked: [] },
  }
}

type ToolExecute = (
  input: SummaryFields,
  toolCtx: { sessionID: string },
) => Promise<{ output: { block: string; status: string }; content: string }>

/** 输入：storage + model + 可选 terminal；输出：捕获的 execute。 */
async function setup(input: {
  storage: StorageLike
  terminal?: string
}): Promise<{ execute: ToolExecute; reads: string[] }> {
  const captured: { execute?: ToolExecute } = {}
  const ctx = {
    storage: input.storage,
    session: {
      get: () => Promise.resolve({ model: { providerID: "fake", id: "model" } }),
      compact: () => Promise.resolve(),
    },
    tool: {
      transform: (fn: (editor: { add: (tool: { execute: ToolExecute }) => void }) => void) => {
        fn({ add: (tool) => (captured.execute = tool.execute) })
        return Promise.resolve({ dispose: () => Promise.resolve() })
      },
    },
  } as unknown as Plugin.Context
  await saveState(input.storage, "ses_a", {
    v: 1,
    blocks: [],
    attempts: 0,
    ...(input.terminal === undefined ? {} : { terminal: input.terminal }),
  })
  const cache = new Map<string, readonly MessageLike[]>([
    ["ses_a", [message("m1", "a".repeat(6_000))]],
  ])
  await registerCompressTool(ctx, cache)
  const execute = captured.execute
  if (execute === undefined) throw new Error("compress tool was not registered")
  return { execute, reads: (input.storage as StorageLike & { reads: string[] }).reads }
}

describe("compress tool", () => {
  it("按会话模型窗口算摘要上限，而不是全局 window:last", async () => {
    const storage = createStorage()
    await storage.set("window:fake/model", 100_000)
    await storage.set("window:last", 50_000)
    const { execute, reads } = await setup({ storage })
    const result = await execute(summary(), { sessionID: "ses_a" })
    expect(result.output.status).toBe("queued")
    expect(reads).toContain("window:fake/model")
    expect(reads).not.toContain("window:last")
  })

  it("终止态拒绝压缩", async () => {
    const storage = createStorage()
    await storage.set("window:fake/model", 100_000)
    const { execute } = await setup({ storage, terminal: "stop now" })
    const result = await execute(summary(), { sessionID: "ses_a" })
    expect(result.output.status).toBe("error")
    expect(result.content).toContain("stop now")
  })
})
