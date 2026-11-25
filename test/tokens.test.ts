import { describe, expect, it } from "vitest"

import {
  bucketize,
  contentCategories,
  countText,
  DEFAULT_BUCKET_COEFS,
  emptyBuckets,
  estimateBuckets,
  estimateCategories,
  priceBuckets,
  priceText,
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
    expect(result.system).toBe(priceText("abcd"))
    expect(result.tools).toBe(priceText("readabcd{}"))
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
    expect(result.text).toBe(priceText("abcd") + priceText("```x```") + priceText("efgh"))
    expect(result.tool).toBe(priceText("tool{}") + priceText("abcdefgh"))
    expect(result.summaries).toBe(priceText("abcd"))
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
    expect(result.tool).toBe(priceText("abcd") + priceText("efgh"))
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
    expect(result.text).toBe(priceText("abcd"))
    expect(result.tool).toBe(priceText("shellabcd") + priceText("efgh"))
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
    expect(result.summaries).toBe(priceText("abcd"))
    expect(result.recent).toBe(priceText("abcdefgh"))
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
    expect(result.summaries).toBe(priceText("abcd") * 2)
    expect(result.recent).toBe(priceText("abcdefgh"))
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
describe("bucketize / priceBuckets", () => {
  it("把文本分进 13 个桶", () => {
    const b = bucketize("你好 world 123 => ok")
    expect(b.cjk).toBe(2)
    expect(b.word2 + b.word35).toBeGreaterThan(0)
    expect(b.num).toBe(1) // "123" 三位数字算一组
    expect(b.punctRun).toBe(1) // "=>" 是连续标点
    expect(b.asciiPunct).toBe(2)
    expect(b.ws).toBeGreaterThan(0)
  })

  it("CJK 标点并入 cjk，避免被算成零成本", () => {
    const b = bucketize("，。：")
    expect(b.cjk).toBe(3)
    expect(b.other).toBe(0)
  })

  it("驼峰边界单独计数", () => {
    expect(bucketize("parseConfig").camel).toBe(1)
    expect(bucketize("parseconfig").camel).toBe(0)
  })

  it("价格 = 桶计数 × 系数（四舍五入）", () => {
    const counts = { ...emptyBuckets(), cjk: 100, latin: 1000 }
    expect(priceBuckets(counts, { ...DEFAULT_BUCKET_COEFS, cjk: 1, latin: 0.25 })).toBe(100 + 250)
    expect(priceBuckets(emptyBuckets())).toBe(0)
  })

  it("priceText 与 priceBuckets(bucketize) 一致", () => {
    for (const text of ["", "hello world", "你好，世界", "a".repeat(500)]) {
      expect(priceText(text)).toBe(priceBuckets(bucketize(text)))
    }
  })
})

describe("estimateBuckets", () => {
  it("汇总 system / 工具定义 / 消息，可再折成 token 合计", () => {
    const input = {
      system: [{ type: "text", text: "系统提示" }],
      tools: { read: { description: "读文件" } },
      messages: [{ content: [{ type: "text", text: "你好世界" }] }],
    }
    const buckets = estimateBuckets(input)
    const categories = estimateCategories(input)
    const total =
      categories.system +
      categories.tools +
      categories.tool +
      categories.text +
      categories.recent +
      categories.summaries +
      categories.media
    // 媒体为 0 时，桶合计应约等于分类合计（分类各自四舍五入，允许个位差）。
    expect(Math.abs(priceBuckets(buckets) - total)).toBeLessThanOrEqual(7)
  })
})

