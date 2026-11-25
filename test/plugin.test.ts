import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
function createFakeContext(
  options: {
    readonly directory?: string
    readonly parentID?: string
    readonly storage?: Plugin.Context["storage"]
  } = {},
) {
  const hooks: RecordedHook[] = []
  const updates: UpdateInput[] = []
  const tools: string[] = []
  const directory = options.directory ?? tmpdir()
  let disposed = false

  const ctx = {
    storage: options.storage ?? {
      get: () => Promise.resolve(undefined),
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      scan: () => Promise.resolve({ entries: [] }),
    },
    location: { directory },
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
      get: () =>
        Promise.resolve({
          metadata: { keep: "yes" },
          location: { directory },
          ...(options.parentID === undefined ? {} : { parentID: options.parentID }),
        }),
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
  it("setup 注册 context / compaction / generate / http 钩子与 compress / decompress 工具", async () => {
    const { ctx, hooks, tools } = createFakeContext()

    await plugin.setup(ctx)

    expect(hooks.map((hook) => hook.name)).toEqual([
      "context",
      "compaction",
      "generate",
      "http.request",
      "http.response",
    ])
    expect(tools).toEqual(["compress", "decompress", "checkpoint_tree"])
  })

  it("开启缓存突变后，http 钩子会把非主请求的 usage 落进 storage", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cc-hooks-"))
    mkdirSync(join(directory, ".opencode"), { recursive: true })
    writeFileSync(join(directory, ".opencode", "compressed-context.json"), JSON.stringify({ cacheDropsEnabled: true }))
    const data = new Map<string, unknown>()
    const storage = {
      get: (key: string) => Promise.resolve(data.get(key)),
      set: (key: string, value: unknown) => {
        data.set(key, value)
        return Promise.resolve()
      },
      remove: (key: string) => {
        data.delete(key)
        return Promise.resolve()
      },
      scan: () => Promise.resolve({ entries: [] }),
    } as unknown as Plugin.Context["storage"]
    const { ctx, hooks } = createFakeContext({ directory, storage })
    await plugin.setup(ctx)

    const requestHook = hooks.find((hook) => hook.name === "http.request")
    const responseHook = hooks.find((hook) => hook.name === "http.response")
    expect(requestHook).toBeDefined()
    expect(responseHook).toBeDefined()

    await requestHook?.callback({
      sessionID: "ses_test",
      kind: "generate",
      request: new Request("http://localhost/generate", {
        method: "POST",
        body: JSON.stringify({ system: "S", messages: [{ role: "user", content: "hi" }] }),
      }),
    })
    await responseHook?.callback({
      sessionID: "ses_test",
      kind: "generate",
      model: { providerID: "p", id: "m" },
      response: new Response(
        'data: {"usage":{"input_tokens":10,"cache_read_input_tokens":90,"output_tokens":5}}',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    })

    await vi.waitFor(() => {
      expect(data.get("cache:history:ses_test")).toBeDefined()
    })
    const history = data.get("cache:history:ses_test") as {
      readonly samples: readonly { readonly input: number; readonly cached: number; readonly hitRate: number }[]
    }
    expect(history.samples).toHaveLength(1)
    expect(history.samples[0]).toMatchObject({ input: 100, cached: 90, hitRate: 90 })
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

  it("context 钩子对子代理隐藏 compress / decompress", async () => {
    const { ctx, hooks } = createFakeContext({ parentID: "ses_parent" })
    await plugin.setup(ctx)

    const tools: Record<string, unknown> = { compress: {}, decompress: {}, read: {} }
    await hooks[0]?.callback({ ...emptyContext, tools })

    expect(Object.keys(tools)).toEqual(["read"])
  })

  it("generate 钩子对子代理隐藏压缩工具", async () => {
    const { ctx, hooks } = createFakeContext({ parentID: "ses_parent" })
    await plugin.setup(ctx)

    const tools: Record<string, unknown> = { compress: {}, decompress: {}, checkpoint_tree: {}, read: {} }
    await hooks[2]?.callback({ ...emptyContext, tools })

    expect(Object.keys(tools)).toEqual(["read"])
  })

  it("开关关闭时在 context 钩子里隐藏对应工具", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cc-plugin-config-"))
    mkdirSync(join(directory, ".opencode"), { recursive: true })
    writeFileSync(
      join(directory, ".opencode", "compressed-context.json"),
      JSON.stringify({ enableCompressTool: false }),
      "utf8",
    )
    const { ctx, hooks } = createFakeContext({ directory })
    await plugin.setup(ctx)

    const tools: Record<string, unknown> = { compress: {}, decompress: {} }
    await hooks[0]?.callback({ ...emptyContext, tools })

    expect(Object.keys(tools)).toEqual(["decompress"])
  })

  it("清理函数会注销注册", async () => {
    const { ctx, wasDisposed } = createFakeContext()

    const cleanup = await plugin.setup(ctx)
    await cleanup?.()

    expect(wasDisposed()).toBe(true)
  })
})
