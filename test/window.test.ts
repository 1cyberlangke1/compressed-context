import { describe, expect, it } from "vitest"
import type { Plugin } from "@opencode/plugin"

import {
  RESOLVED_WINDOW_KEY,
  readStoredWindow,
  resolvedWindowKey,
  windowKey,
} from "../src/compression/settings.ts"

/** 输入：storage 里的键值 + session.get 实现；输出：最小插件上下文。 */
function ctxWith(input: {
  readonly values: Readonly<Record<string, unknown>>
  readonly session?: () => Promise<unknown>
  readonly seen?: string[]
}): Plugin.Context {
  return {
    storage: {
      get: (key: string) => {
        input.seen?.push(key)
        return Promise.resolve(input.values[key])
      },
    },
    session: {
      get:
        input.session ??
        (() => Promise.resolve({ model: { providerID: "fake", id: "model" } })),
    },
  } as unknown as Plugin.Context
}

describe("readStoredWindow", () => {
  it("优先用会话模型自己的窗口", async () => {
    const seen: string[] = []
    const ctx = ctxWith({
      values: {
        [windowKey("fake", "model")]: 200_000,
        [resolvedWindowKey("ses_a")]: 128_000,
        [RESOLVED_WINDOW_KEY]: 64_000,
      },
      seen,
    })

    expect(await readStoredWindow(ctx, "ses_a")).toBe(200_000)
    expect(seen).toEqual([windowKey("fake", "model")])
  })

  it("模型窗口缺失时回退到该会话解析值", async () => {
    const ctx = ctxWith({
      values: {
        [windowKey("fake", "model")]: 0,
        [resolvedWindowKey("ses_a")]: 128_000,
        [RESOLVED_WINDOW_KEY]: 64_000,
      },
    })

    expect(await readStoredWindow(ctx, "ses_a")).toBe(128_000)
  })

  it("会话查询失败时仍按会话/全局缓存回退", async () => {
    const ctx = ctxWith({
      values: { [resolvedWindowKey("ses_a")]: 128_000 },
      session: () => Promise.reject(new Error("not found")),
    })

    expect(await readStoredWindow(ctx, "ses_a")).toBe(128_000)
  })

  it("各级缓存都没有时回退全局值；负数与非数字忽略", async () => {
    const ctx = ctxWith({
      values: {
        [windowKey("fake", "model")]: -1,
        [resolvedWindowKey("ses_a")]: "128k",
        [RESOLVED_WINDOW_KEY]: 64_000,
      },
    })

    expect(await readStoredWindow(ctx, "ses_a")).toBe(64_000)
  })

  it("没有 sessionID 时只读全局值", async () => {
    const seen: string[] = []
    const ctx = ctxWith({ values: { [RESOLVED_WINDOW_KEY]: 64_000 }, seen })

    expect(await readStoredWindow(ctx)).toBe(64_000)
    expect(seen).toEqual([RESOLVED_WINDOW_KEY])
  })

  it("全部缺失时返回 undefined", async () => {
    const ctx = ctxWith({ values: {} })
    expect(await readStoredWindow(ctx, "ses_a")).toBeUndefined()
  })
})
