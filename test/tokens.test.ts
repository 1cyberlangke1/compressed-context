import { describe, expect, it } from "vitest"

import { countText, estimateCategories } from "../src/tokens.ts"

describe("countText", () => {
  it("ASCII 按 4 字符取整，CJK 按 1:1", () => {
    expect(countText("")).toBe(0)
    expect(countText("abcde")).toBe(2)
    expect(countText("你好abcd")).toBe(3)
  })
})

describe("estimateCategories", () => {
  it("统计 system 与工具定义", () => {
    const result = estimateCategories({
      system: [{ type: "text", text: "abcd" }],
      tools: { read: { description: "abcd", input: {} } },
      messages: [],
    })
    expect(result.system).toBe(1)
    expect(result.tools).toBe(3)
  })

  it("按内容分类：text / reasoning / tool / summaries / media", () => {
    const result = estimateCategories({
      system: [],
      tools: {},
      messages: [
        {
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
    expect(result.text).toBe(4)
    expect(result.tool).toBe(4)
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

  it("未知 part 类型不计入任何分类", () => {
    const result = estimateCategories({
      system: [],
      tools: {},
      messages: [{ content: [{ type: "effort" }] }],
    })
    expect(result).toEqual({ system: 0, tools: 0, tool: 0, text: 0, summaries: 0, media: 0 })
  })
})
