import { describe, expect, it } from "vitest"

import {
  messageRowToText,
  parseMessageData,
  rowsInRange,
  type SessionMessageRow,
} from "../src/compression/history.ts"

describe("history 只读直查", () => {
  const userRow: SessionMessageRow = {
    id: "msg_1",
    session_id: "ses_x",
    type: "user",
    seq: 10,
    data: JSON.stringify({
      id: "msg_1",
      type: "user",
      time: { created: 1 },
      text: "hello world",
    }),
  }

  const assistantRow: SessionMessageRow = {
    id: "msg_2",
    session_id: "ses_x",
    type: "assistant",
    seq: 20,
    data: JSON.stringify({
      id: "msg_2",
      type: "assistant",
      time: { created: 2 },
      content: [{ type: "text", text: "answer" }],
    }),
  }

  const toolRow: SessionMessageRow = {
    id: "msg_4",
    session_id: "ses_x",
    type: "assistant",
    seq: 40,
    data: JSON.stringify({
      id: "msg_4",
      type: "assistant",
      time: { created: 4 },
      content: [
        { type: "tool-call", name: "read", input: { path: "a.ts" } },
        { type: "tool-result", name: "read", result: { value: "file body" } },
      ],
    }),
  }

  const compactionRow: SessionMessageRow = {
    id: "msg_3",
    session_id: "ses_x",
    type: "compaction",
    seq: 30,
    data: JSON.stringify({
      id: "msg_3",
      type: "compaction",
      time: { created: 3 },
      status: "completed",
      summary: "checkpoint",
    }),
  }

  it("解析 user 消息的 data JSON", () => {
    const parsed = parseMessageData(userRow)
    expect(parsed?.role).toBe("user")
    expect(parsed?.parts).toEqual([{ type: "text", text: "hello world" }])
  })

  it("解析 assistant 消息的 content parts", () => {
    const parsed = parseMessageData(assistantRow)
    expect(parsed?.role).toBe("assistant")
    expect(parsed?.parts).toEqual([{ type: "text", text: "answer" }])
  })

  it("解析 assistant 的 tool-call / tool-result parts", () => {
    const parsed = parseMessageData(toolRow)
    expect(parsed?.parts).toEqual([
      { type: "tool-call", name: "read", input: { path: "a.ts" } },
      { type: "tool-result", name: "read", result: { value: "file body" } },
    ])
  })

  it("损坏的 data 返回 undefined，不抛错", () => {
    expect(parseMessageData({ ...userRow, data: "{broken" })).toBeUndefined()
  })

  it("非原文类型（compaction）返回 undefined", () => {
    expect(parseMessageData(compactionRow)).toBeUndefined()
  })

  it("消息渲染成 transcript 行，user 带角色标注", () => {
    expect(messageRowToText(userRow)).toBe("[User]\nhello world")
    expect(messageRowToText(assistantRow)).toBe("answer")
  })

  it("跳过 compaction 等非原文类型，输出空串", () => {
    expect(messageRowToText(compactionRow)).toBe("")
  })

  it("按 seq 范围过滤并保持顺序，跳过非原文行", () => {
    const rows = [userRow, assistantRow, compactionRow, toolRow]
    const picked = rowsInRange(rows, "msg_1", "msg_4")
    expect(picked.map((row) => row.id)).toEqual(["msg_1", "msg_2", "msg_4"])
  })

  it("范围两端的 id 不存在时返回空数组", () => {
    expect(rowsInRange([userRow], "msg_missing", "msg_1")).toEqual([])
  })
})
