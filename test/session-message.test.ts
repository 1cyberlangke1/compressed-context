import { describe, expect, it } from "vitest"

import { sessionMessagesToMessageLikes } from "../src/compression/session-message.ts"

describe("sessionMessagesToMessageLikes", () => {
  it("把 user.text/files 和 assistant.content 转成 MessageLike", () => {
    const messages = sessionMessagesToMessageLikes([
      {
        id: "m1",
        type: "user",
        text: "hello",
        files: [
          {
            data: "aGVsbG8=",
            mime: "image/png",
            name: "x.png",
            source: { type: "inline" },
          },
        ],
      },
      {
        id: "m2",
        type: "assistant",
        content: [
          { type: "text", text: "answer" },
          { type: "reasoning", text: "hidden" },
          {
            type: "tool",
            name: "read",
            state: { status: "completed", input: { path: "a.txt" }, content: [{ type: "text", text: "ok" }] },
          },
        ],
      },
      { id: "m3", type: "agent-switched", agent: "x" },
    ])
    expect(messages).toHaveLength(2)
    expect(messages[0]?.content[0]).toEqual({ type: "text", text: "hello" })
    expect(messages[0]?.content[1]).toMatchObject({
      type: "media",
      filename: "x.png",
      media: { source: { type: "base64", data: "aGVsbG8=", mediaType: "image/png" } },
    })
    expect(messages[1]?.content.some((part) => part.type === "reasoning")).toBe(false)
    expect(messages[1]?.content[0]).toEqual({ type: "text", text: "answer" })
    expect(messages[1]?.content[1]).toMatchObject({ type: "tool-call", name: "read" })
    expect(messages[1]?.content[2]).toMatchObject({ type: "tool-result", name: "read" })
  })
})
