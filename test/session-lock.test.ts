import { describe, expect, it } from "vitest"

import { sessionChains, withSessionLock } from "../src/compression/session-lock.ts"

/** 输入：毫秒；输出：等待 Promise。预期：只用于制造执行顺序。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("session-lock", () => {
  it("同一个会话按入队顺序串行", async () => {
    const tails = sessionChains(Symbol.for("compressed-context.test-lock-order"))
    const order: number[] = []

    await Promise.all([
      withSessionLock(tails, "ses_a", async () => {
        await delay(10)
        order.push(1)
      }),
      withSessionLock(tails, "ses_a", () => {
        order.push(2)
        return Promise.resolve()
      }),
    ])

    expect(order).toEqual([1, 2])
    // 队列结束后清理自己入队的 tail。
    expect(tails.has("ses_a")).toBe(false)
  })

  it("不同会话互不阻塞", async () => {
    const tails = sessionChains(Symbol.for("compressed-context.test-lock-parallel"))
    const order: string[] = []

    await Promise.all([
      withSessionLock(tails, "ses_slow", async () => {
        await delay(10)
        order.push("slow")
      }),
      withSessionLock(tails, "ses_fast", () => {
        order.push("fast")
        return Promise.resolve()
      }),
    ])

    expect(order).toEqual(["fast", "slow"])
  })

  it("任务异常向上抛，且不会卡住后续任务", async () => {
    const tails = sessionChains(Symbol.for("compressed-context.test-lock-error"))

    await expect(
      withSessionLock(tails, "ses_a", () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom")

    await expect(withSessionLock(tails, "ses_a", () => Promise.resolve(7))).resolves.toBe(7)
    expect(tails.has("ses_a")).toBe(false)
  })

  it("同一符号共用一张表，不同符号互不影响", () => {
    const first = sessionChains(Symbol.for("compressed-context.test-lock-shared"))
    const again = sessionChains(Symbol.for("compressed-context.test-lock-shared"))
    const other = sessionChains(Symbol.for("compressed-context.test-lock-other"))

    expect(first).toBe(again)
    expect(other).not.toBe(first)
  })
})
