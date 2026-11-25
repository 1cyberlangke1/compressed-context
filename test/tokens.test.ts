import { describe, expect, it } from "vitest"

import {
  charsTokens,
  contentCategories,
  countChars,
  countText,
  estimateCategories,
  estimateChars,
} from "../src/shared/tokens.ts"

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
            { type: "media", media: { source: { type: "base64", mediaType: "image/png" } } },
          ],
        },
      ],
    })
    expect(result.text).toBe(4)
    expect(result.tool).toBe(4)
    expect(result.summaries).toBe(1)
    expect(result.media).toBe(1_500)
  })

  it("media.info 的宽高用通用图片公式", () => {
    const result = estimateCategories({
      system: [],
      tools: {},
      messages: [
        {
          content: [
            {
              type: "media",
              media: {
                source: { type: "base64", mediaType: "image/png" },
                info: { width: 1000, height: 1000 },
              },
            },
          ],
        },
      ],
    })
    expect(result.media).toBe(1334)
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

  it("v2 tool part 的 state.input / state.content 都计入 tool", () => {
    const result = estimateCategories({
      system: [],
      tools: {},
      messages: [
        {
          text: "abcd",
          content: [
            {
              type: "tool",
              name: "shell",
              state: {
                input: "abcd",
                content: [{ type: "text", text: "efgh" }],
              },
            },
          ],
        },
      ],
    })
    expect(result.text).toBe(1)
    expect(result.tool).toBe(4)
  })

  it("checkpoint 的 summary 与 recent 分开计数", () => {
    const result = estimateCategories({
      system: [],
      tools: {},
      messages: [
        {
          content: [
            {
              type: "text",
              text: "<conversation-checkpoint>\n<summary>abcd</summary>\n<recent-context>abcdefgh</recent-context>\n</conversation-checkpoint>",
            },
          ],
        },
      ],
    })
    expect(result.summaries).toBe(1)
    expect(result.recent).toBe(2)
  })

  it("多个 checkpoint 只取最新 recent，不累加", () => {
    const result = estimateCategories({
      system: [],
      tools: {},
      messages: [
        {
          content: [
            {
              type: "text",
              text: "<conversation-checkpoint>\n<summary>abcd</summary>\n<recent-context>aaaa</recent-context>\n</conversation-checkpoint>",
            },
            {
              type: "text",
              text: "<conversation-checkpoint>\n<summary>abcd</summary>\n<recent-context>abcdefgh</recent-context>\n</conversation-checkpoint>",
            },
          ],
        },
      ],
    })
    expect(result.summaries).toBe(2)
    expect(result.recent).toBe(2)
  })

  it("未知 part 类型不计入任何分类", () => {
    const result = estimateCategories({
      system: [],
      tools: {},
      messages: [{ content: [{ type: "effort" }] }],
    })
    expect(result).toEqual({ system: 0, tools: 0, tool: 0, text: 0, recent: 0, summaries: 0, media: 0 })
  })
})

describe("contentCategories", () => {
  it("只汇总会增长的对话内容：工具定义 + 工具结果 + 文本 + 媒体", () => {
    const categories = {
      system: 12_000,
      tools: 5_300,
      tool: 35_000,
      text: 16_000,
      recent: 26_000,
      summaries: 61_000,
      media: 1_500,
    }
    // 系统提示词、最近保留区、摘要块都不算「新长出来的内容」。
    expect(contentCategories(categories)).toBe(5_300 + 35_000 + 16_000 + 1_500)
  })

  it("空估算返回 0", () => {
    expect(
      contentCategories({ system: 0, tools: 0, tool: 0, text: 0, recent: 0, summaries: 0, media: 0 }),
    ).toBe(0)
  })
})

describe("countChars / charsTokens", () => {
  it("按 CJK 与其它字符分开计数", () => {
    expect(countChars("")).toEqual({ cjk: 0, ascii: 0 })
    expect(countChars("你好ab")).toEqual({ cjk: 2, ascii: 2 })
  })

  it("默认系数下与 countText 完全一致", () => {
    for (const text of ["", "abcde", "你好abcd", "T=标题|G=目标", "a".repeat(1000)]) {
      expect(charsTokens(countChars(text))).toBe(countText(text))
    }
  })

  it("自定义系数按字符类型分别折算", () => {
    const chars = { cjk: 100, ascii: 1000 }
    expect(charsTokens(chars, { cjk: 0.5, ascii: 0.25 })).toBe(50 + 250)
    expect(charsTokens(chars, { cjk: 2, ascii: 1 })).toBe(1200)
  })
})

describe("estimateChars", () => {
  it("汇总 system / 工具定义 / 消息的字符数，不含媒体", () => {
    const chars = estimateChars({
      system: [{ type: "text", text: "abcd" }],
      tools: { read: { description: "abcd", input: {} } },
      messages: [
        {
          content: [
            { type: "text", text: "你好" },
            { type: "media", media: { source: { mediaType: "image/png" }, info: { width: 100, height: 100 } } },
          ],
        },
      ],
    })
    expect(chars.cjk).toBe(2)
    // 4(系统) + 4(工具名) + 4(描述) + 2(JSON "{}")；媒体不计入字符数。
    expect(chars.ascii).toBe(14)
  })

  it("按系数估算后与 estimateCategories 合计一致（默认系数）", () => {
    const input = {
      system: [{ type: "text", text: "系统提示" }],
      tools: { read: { description: "读文件" } },
      messages: [{ content: [{ type: "text", text: "你好世界" }] }],
    }
    const chars = estimateChars(input)
    const categories = estimateCategories(input)
    const total = categories.system + categories.tools + categories.tool + categories.text + categories.recent + categories.summaries + categories.media
    expect(charsTokens(chars)).toBe(total)
  })
})
