import { describe, expect, it } from "vitest"
import type { Plugin } from "@opencode/plugin"

import { startSessionEvents } from "../src/compression/events.ts"

/**
 * 输入：要依次派发的事件列表 + 可选会话归属表。
 * 输出：只提供 event.subscribe 与 session.get 的假 ctx。
 * 预期：订阅体按顺序 yield 完即结束，避免测试挂住；
 *       会话默认属于本实例目录（configDirectories 未登记时用 /work）。
 */
function ctxWith(
  events: readonly unknown[],
  sessions: Readonly<Record<string, string | undefined>> = {},
): Plugin.Context {
  return {
    location: { directory: "/work" },
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
})
