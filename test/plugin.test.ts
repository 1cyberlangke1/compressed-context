import type { Plugin } from "@opencode/plugin"
import { describe, expect, it, vi } from "vitest"

import plugin from "../src/index.ts"
import { STATS_KEY } from "../src/stats.ts"

interface RecordedHook {
  readonly name: string
  readonly callback: (input: unknown) => void
}

interface UpdateInput {
  readonly sessionID: string
  readonly metadata?: Record<string, unknown>
}

/**
 * 输入：无。
 * 输出：只实现 session.hook/get/update 的假 ctx，以及记录数组。
 * 预期：足够让插件 setup 跑完，不需要真实 OpenCode 宿主。
 */
function createFakeContext() {
  const hooks: RecordedHook[] = []
  const updates: UpdateInput[] = []
  let disposed = false

  const ctx = {
    session: {
      hook: (name: string, callback: (input: unknown) => void) => {
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
    },
  }

  return { ctx: ctx as unknown as Plugin.Context, hooks, updates, wasDisposed: () => disposed }
}

const emptyContext = { sessionID: "ses_test", system: [], tools: {}, messages: [] }

describe("服务端插件入口", () => {
  it("setup 注册 context 钩子", async () => {
    const { ctx, hooks } = createFakeContext()

    await plugin.setup(ctx)

    expect(hooks.map((hook) => hook.name)).toEqual(["context"])
  })

  it("钩子把统计合并进 session metadata", async () => {
    const { ctx, hooks, updates } = createFakeContext()
    await plugin.setup(ctx)

    hooks[0]?.callback(emptyContext)

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

    hooks[0]?.callback(emptyContext)
    hooks[0]?.callback(emptyContext)

    await vi.waitFor(() => {
      expect(updates).toHaveLength(1)
    })
  })

  it("清理函数会注销钩子", async () => {
    const { ctx, wasDisposed } = createFakeContext()

    const cleanup = await plugin.setup(ctx)
    await cleanup?.()

    expect(wasDisposed()).toBe(true)
  })
})
