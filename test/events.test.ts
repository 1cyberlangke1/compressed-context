import { describe, expect, it } from "vitest"
import type { Plugin } from "@opencode/plugin"

import { startSessionEvents } from "../src/compression/events.ts"

/**
 * 输入：要依次派发的事件列表。
 * 输出：只提供 event.subscribe 的假 ctx。
 * 预期：订阅体按顺序 yield 完即结束，避免测试挂住。
 */
function ctxWith(events: readonly unknown[]): Plugin.Context {
  return {
    event: {
      subscribe: async function* () {
        for (const event of events) {
          await Promise.resolve()
          yield event
        }
      },
    },
  } as unknown as Plugin.Context
}

describe("会话事件订阅", () => {
  it("step.ended 的 usage 会被归一化后回调", async () => {
    const seen: unknown[] = []
    let done!: () => void
    const finished = new Promise<void>((resolve) => {
      done = resolve
    })
    const cancel = startSessionEvents(
      ctxWith([
        {
          type: "session.step.ended",
          data: {
            sessionID: "ses_x",
            assistantMessageID: "m1",
            tokens: { input: 5, cache: { read: 7 } },
          },
        },
      ]),
      {
        onStepEnded: (input) => {
          seen.push(input)
          done()
        },
      },
    )
    await finished
    cancel()
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
    let done!: () => void
    const finished = new Promise<void>((resolve) => {
      done = resolve
    })
    const cancel = startSessionEvents(
      ctxWith([
        { type: "session.step.ended", data: { sessionID: "ses_x", tokens: { cache: { read: 1 } } } },
        { type: "session.step.ended", data: { sessionID: "ses_y", tokens: { input: 3 } } },
      ]),
      {
        onStepEnded: (input) => {
          seen.push(input)
          done()
        },
      },
    )
    await finished
    cancel()
    expect(seen).toHaveLength(1)
    expect((seen[0] as { sessionID: string }).sessionID).toBe("ses_y")
  })

  it("缺少 tokens 字段时不回调", async () => {
    let calls = 0
    const cancel = startSessionEvents(
      ctxWith([
        { type: "session.step.ended", data: { sessionID: "ses_x" } },
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
})
