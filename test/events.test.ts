import { describe, expect, it } from "vitest"
import type { Plugin } from "@opencode/plugin"

import { hasBlockInLatestCompaction, startSessionEvents } from "../src/compression/events.ts"

/**
 * 输入：要依次派发的事件列表 + 可选会话归属表。
 * 输出：只提供 event.subscribe 与 session.get 的假 ctx。
 * 预期：订阅体按顺序 yield 完即结束，避免测试挂住；
 *       会话默认属于本实例目录（configDirectories 未登记时用 /work）。
 */
function ctxWith(
  events: readonly unknown[],
  sessions: Readonly<Record<string, string | undefined>> = {},
  directory = "/work",
): Plugin.Context {
  return {
    location: { directory },
    event: {
      subscribe: async function* () {
        for (const event of events) {
          await Promise.resolve()
          yield event
        }
      },
    },
    session: {
      get: ({ sessionID }: { sessionID: string }) => {
        const directory = sessions[sessionID] ?? "/work"
        return Promise.resolve({ sessionID, location: { directory } })
      },
    },
  } as unknown as Plugin.Context
}

/** 输入：事件列表 + 回调装配；输出：等订阅把事件跑完的 Promise。 */
function run(events: readonly unknown[], collect: (value: unknown) => void, sessions?: Readonly<Record<string, string | undefined>>, count = 1): Promise<void> {
  return new Promise((resolve) => {
    let seen = 0
    startSessionEvents(ctxWith(events, sessions), {
      onStepEnded: (input) => {
        collect(input)
        seen += 1
        if (seen >= count) resolve()
      },
    })
  })
}

/** 输入：条件；输出：条件成立时 resolve，超过 1s 抛错。 */
async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("condition not met")
}

describe("会话事件订阅", () => {
  it("step.ended 的 usage 会被归一化后回调", async () => {
    const seen: unknown[] = []
    await run(
      [
        {
          type: "session.step.ended",
          data: {
            sessionID: "ses_x",
            assistantMessageID: "m1",
            tokens: { input: 5, cache: { read: 7 } },
          },
        },
      ],
      (value) => seen.push(value),
    )
    expect(seen).toEqual([
      {
        sessionID: "ses_x",
        messageID: "m1",
        tokens: { input: 5, output: 0, reasoning: 0, cache: { read: 7, write: 0 } },
      },
    ])
  })

  it("tokens 形状不对时跳过该事件，后续合法事件仍然回调", async () => {
    const seen: unknown[] = []
    await run(
      [
        { type: "session.step.ended", data: { sessionID: "ses_x", assistantMessageID: "m0", tokens: { cache: { read: 1 } } } },
        { type: "session.step.ended", data: { sessionID: "ses_y", assistantMessageID: "m1", tokens: { input: 3 } } },
      ],
      (value) => seen.push(value),
    )
    expect(seen).toHaveLength(1)
    expect((seen[0] as { sessionID: string }).sessionID).toBe("ses_y")
  })

  it("缺少 tokens 字段时不回调", async () => {
    let calls = 0
    const cancel = startSessionEvents(
      ctxWith([
        { type: "session.step.ended", data: { sessionID: "ses_x", assistantMessageID: "m1" } },
        { type: "session.unknown", data: { sessionID: "ses_x" } },
      ]),
      {
        onStepEnded: () => {
          calls += 1
        },
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    cancel()
    expect(calls).toBe(0)
  })

  it("缺少 messageID 的 step.ended 直接跳过，不写空串样本", async () => {
    let calls = 0
    const cancel = startSessionEvents(
      ctxWith([
        { type: "session.step.ended", data: { sessionID: "ses_x", tokens: { input: 5 } } },
        { type: "session.step.ended", data: { sessionID: "ses_x", assistantMessageID: "", tokens: { input: 5 } } },
      ]),
      {
        onStepEnded: () => {
          calls += 1
        },
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    cancel()
    expect(calls).toBe(0)
  })

  it("别的 location 的 step.ended 不回调", async () => {
    let calls = 0
    const cancel = startSessionEvents(
      ctxWith(
        [{ type: "session.step.ended", data: { sessionID: "ses_x", assistantMessageID: "m1", tokens: { input: 5 } } }],
        { ses_x: "/other" },
      ),
      {
        onStepEnded: () => {
          calls += 1
        },
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    cancel()
    expect(calls).toBe(0)
  })

  it("单条事件处理抛错时订阅继续，后续事件仍然回调", async () => {
    const seen: unknown[] = []
    await run(
      [
        {
          type: "session.step.ended",
          data: { sessionID: "ses_x", assistantMessageID: "m1", tokens: { input: 5 } },
        },
        {
          type: "session.step.ended",
          data: { sessionID: "ses_x", assistantMessageID: "m2", tokens: { input: 6 } },
        },
      ],
      (value) => {
        // 第一条故意抛错，模拟 handler 内部异常。
        if ((value as { messageID: string }).messageID === "m1") throw new Error("boom")
        seen.push(value)
      },
    )
    expect(seen).toHaveLength(1)
    expect((seen[0] as { messageID: string }).messageID).toBe("m2")
  })

  it("同一会话的事件按到达顺序串行", async () => {
    const seen: string[] = []
    const cancel = startSessionEvents(
      ctxWith([
        { type: "session.step.ended", data: { sessionID: "ses_x", assistantMessageID: "m1", tokens: { input: 5 } } },
        { type: "session.step.ended", data: { sessionID: "ses_x", assistantMessageID: "m2", tokens: { input: 6 } } },
      ]),
      {
        onStepEnded: async (input) => {
          // 第一条故意更慢：没有串行队列时会先看到 m2。
          await new Promise((resolve) => setTimeout(resolve, input.messageID === "m1" ? 20 : 0))
          seen.push(input.messageID)
        },
      },
    )
    await waitFor(() => seen.length === 2)
    cancel()
    expect(seen).toEqual(["m1", "m2"])
  })

  it("不同实例只处理自己 location 的会话，不跨实例重复记账", async () => {
    const events = [
      { type: "session.step.ended", data: { sessionID: "ses_a", assistantMessageID: "m1", tokens: { input: 5 } } },
      { type: "session.step.ended", data: { sessionID: "ses_b", assistantMessageID: "m2", tokens: { input: 6 } } },
    ]
    const directories = { ses_a: "/a", ses_b: "/b" }
    const seen: string[] = []
    // 两个实例站在同一进程的不同目录上，事件总线会把同一条事件各投一份。
    const cancelA = startSessionEvents(ctxWith(events, directories, "/a"), {
      onStepEnded: (input) => {
        seen.push(`a:${input.sessionID}`)
      },
    })
    const cancelB = startSessionEvents(ctxWith(events, directories, "/b"), {
      onStepEnded: (input) => {
        seen.push(`b:${input.sessionID}`)
      },
    })
    await waitFor(() => seen.length >= 2)
    cancelA()
    cancelB()
    expect(seen.sort()).toEqual(["a:ses_a", "b:ses_b"])
  })

  it("不同会话互不阻塞：慢会话不拖住其它会话记账", async () => {
    const order: string[] = []
    let release: () => void = () => {
      // 由 Promise executor 立即替换成真正的 resolve。
    }
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const cancel = startSessionEvents(
      ctxWith([
        {
          type: "session.step.ended",
          data: { sessionID: "ses_slow", assistantMessageID: "m1", tokens: { input: 5 } },
        },
        {
          type: "session.step.ended",
          data: { sessionID: "ses_fast", assistantMessageID: "m2", tokens: { input: 6 } },
        },
      ]),
      {
        onStepEnded: async (input) => {
          if (input.sessionID === "ses_slow") await gate
          order.push(input.sessionID)
        },
      },
    )
    await waitFor(() => order.includes("ses_fast"))
    // 慢会话还被门挡着，快会话已经记完。
    expect(order).toEqual(["ses_fast"])
    release()
    await waitFor(() => order.length === 2)
    cancel()
    expect(order).toEqual(["ses_fast", "ses_slow"])
  })
})

describe("hasBlockInLatestCompaction", () => {
  /** 输入：messages；输出：只提供 session.context 的假 ctx。预期：用于直接验证最新 checkpoint 判定。 */
  const ctxWithContext = (messages: readonly unknown[]): Plugin.Context =>
    ({ session: { context: () => Promise.resolve(messages) } }) as unknown as Plugin.Context

  it("取最后一条 completed compaction，而不是第一条", async () => {
    const ctx = ctxWithContext([
      { type: "compaction", status: "completed", summary: "[Compressed conversation section #b1]" },
      { type: "user", text: "hi" },
      { type: "compaction", status: "completed", summary: "no marker here" },
    ])
    // b1 只在更早那条里出现：按「第一条」判定会误 commit 一个已经不存在的 pending。
    expect(await hasBlockInLatestCompaction(ctx, "ses_test", "b1")).toBe(false)
    expect(await hasBlockInLatestCompaction(ctx, "ses_test", "b9")).toBe(false)
  })

  it("最新一条包含待确认块时返回 true", async () => {
    const ctx = ctxWithContext([
      { type: "compaction", status: "completed", summary: "old" },
      { type: "user", text: "hi" },
      { type: "compaction", status: "completed", summary: "[Compressed conversation section #b7] T1" },
    ])
    expect(await hasBlockInLatestCompaction(ctx, "ses_test", "b7")).toBe(true)
  })
})