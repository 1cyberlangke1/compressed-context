import { tmpdir } from "node:os"
import type { Plugin } from "@opencode/plugin"
import { describe, expect, it, vi } from "vitest"

import plugin from "../src/index.ts"
import { STATS_KEY } from "../src/shared/stats.ts"

interface RecordedHook {
  readonly name: string
  readonly callback: (input: unknown) => void | Promise<void>
}

interface UpdateInput {
  readonly sessionID: string
  readonly metadata?: Record<string, unknown>
}

/**
 * 输入：无。
 * 输出：覆盖 setup 所需域的最小假 ctx。
 * 预期：不需要真实 OpenCode 宿主即可跑完注册流程。
 */
function createFakeContext() {
  const hooks: RecordedHook[] = []
  const updates: UpdateInput[] = []
  const tools: string[] = []
  let disposed = false

  const ctx = {
    storage: {
      get: () => Promise.resolve(undefined),
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      scan: () => Promise.resolve({ entries: [] }),
    },
    location: { directory: tmpdir() },
    tool: {
      transform: (fn: (editor: { add: (tool: { name: string }) => void }) => void) => {
        fn({ add: (tool) => tools.push(tool.name) })
        return Promise.resolve({ dispose: () => Promise.resolve() })
      },
      reload: () => Promise.resolve(),
    },
    rpc: {
      register: () => Promise.resolve({ dispose: () => Promise.resolve() }),
    },
    event: {
      subscribe: () =>
        (async function* empty() {
          // no events in tests
        })(),
    },
    model: {
      list: () => Promise.resolve({ data: [] }),
    },
    generate: {
      text: () => Promise.resolve({ text: "" }),
    },
    session: {
      hook: (name: string, callback: (input: unknown) => void | Promise<void>) => {
        hooks.push({ name, callback })
        return Promise.resolve({
          dispose: () => {
            disposed = true
            return Promise.resolve()
          },
        })
      },
      get: () => Promise.resolve({ metadata: { keep: "yes" } }),
      update: (input: UpdateInput) => {
        updates.push(input)
        return Promise.resolve()
      },
      compact: () => Promise.resolve(),
      context: () => Promise.resolve([]),
    },
  }

  return { ctx: ctx as unknown as Plugin.Context, hooks, updates, tools, wasDisposed: () => disposed }
}

const emptyContext = {
  sessionID: "ses_test",
  system: [],
  tools: {},
  messages: [],
  model: { providerID: "provider", id: "model" },
}

describe("服务端插件入口", () => {
  it("setup 注册 context / compaction 钩子与 compress / decompress 工具", async () => {
    const { ctx, hooks, tools } = createFakeContext()

    await plugin.setup(ctx)

    expect(hooks.map((hook) => hook.name)).toEqual(["context", "compaction", "prompt"])
    expect(tools).toEqual(["compress", "decompress"])
  })

  it("context 钩子把统计合并进 session metadata", async () => {
    const { ctx, hooks, updates } = createFakeContext()
    await plugin.setup(ctx)

    await hooks[0]?.callback(emptyContext)

    await vi.waitFor(() => {
      expect(updates).toHaveLength(1)
    })
    expect(updates[0]?.sessionID).toBe("ses_test")
    expect(updates[0]?.metadata?.["keep"]).toBe("yes")
    expect(updates[0]?.metadata?.[STATS_KEY]).toMatchObject({ estimatedTotal: 0 })
  })

  it("统计没变化时不再重复写入", async () => {
    const { ctx, hooks, updates } = createFakeContext()
    await plugin.setup(ctx)

    await hooks[0]?.callback(emptyContext)
    await hooks[0]?.callback(emptyContext)

    await vi.waitFor(() => {
      expect(updates).toHaveLength(1)
    })
  })

  it("清理函数会注销注册", async () => {
    const { ctx, wasDisposed } = createFakeContext()

    const cleanup = await plugin.setup(ctx)
    await cleanup?.()

    expect(wasDisposed()).toBe(true)
  })
})
