import { describe, expect, it } from "vitest"

import { countText, estimateCategories } from "../src/tokens.ts"

describe("countText", () => {
  it("空串返回 0", () => {
    expect(countText("")).toBe(0)
  })

  it("纯 ASCII 按 4 字符 1 token 向上取整", () => {
    expect(countText("abcd")).toBe(1)
    expect(countText("abcde")).toBe(2)
    expect(countText("a")).toBe(1)
  })

  it("CJK 字符按 1:1 计", () => {
    expect(countText("你好")).toBe(2)
    expect(countText("你好abcd")).toBe(3)
  })
})

describe("estimateCategories", () => {
  it("system 只统计 text 片段", () => {
    const result = estimateCategories({
      system: [
        { type: "text", text: "abcd" },
        { type: "text", text: "efgh" },
      ],
      tools: {},
      messages: [],
    })
    expect(result.system).toBe(2)
  })

  it("工具定义按 name + description + schema 计数", () => {
    const result = estimateCategories({
      system: [],
      tools: {
        read: { description: "abcd", input: {} },
      },
      messages: [],
    })
    // "read" + "abcd" + "{}" = 10 字符 -> ceil(10 / 4) = 3
    expect(result.tools).toBe(3)
  })

  it("按内容分类：text / reasoning / tool / summaries / media", () => {
    const result = estimateCategories({
      system: [],
      tools: {},
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "abcd" },
            { type: "text", text: "```x```" },
            { type: "reasoning", text: "efgh" },
            { type: "tool-call", name: "tool", input: {} },
            { type: "tool-result", name: "tool", result: { type: "text", value: "abcdefgh" } },
            { type: "compaction", text: "abcd" },
            { type: "media", media: { mediaType: "image/png" } },
          ],
        },
      ],
    })
    expect(result.text).toBe(4) // "abcd" + "```x```" + reasoning "efgh"
    expect(result.tool).toBe(4) // tool-call 2 + tool-result 2
    expect(result.summaries).toBe(1)
    expect(result.media).toBe(1_500)
  })

  it("tool-result 的 content 数组逐项计数", () => {
    const result = estimateCategories({
      system: [],
      tools: {},
      messages: [
        {
          content: [
            {
              type: "tool-result",
              name: "tool",
              result: {
                type: "content",
                value: [
                  { type: "text", text: "abcd" },
                  { type: "text", text: "efgh" },
                ],
              },
            },
          ],
        },
      ],
    })
    expect(result.tool).toBe(2)
  })

  it("PDF 使用固定估算值", () => {
    const result = estimateCategories({
      system: [],
      tools: {},
      messages: [{ content: [{ type: "media", media: { mediaType: "application/pdf" } }] }],
    })
    expect(result.media).toBe(2_000)
  })

  it("未知 part 类型不计入任何分类", () => {
    const result = estimateCategories({
      system: [],
      tools: {},
      messages: [{ content: [{ type: "effort" }] }],
    })
    expect(result).toEqual({
      system: 0,
      tools: 0,
      tool: 0,
      text: 0,
      summaries: 0,
      media: 0,
    })
  })
})
