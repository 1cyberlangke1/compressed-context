import { describe, expect, it } from "vitest"

import { deriveMarkdownTitle, markdownGoal, toMarkdownSummary } from "../src/compression/markdown.ts"
import { toSummary } from "../src/compression/normalize.ts"
import { renderSummary } from "../src/compression/render.ts"
import { isMarkdownSummary } from "../src/compression/schema.ts"
import { summarize, summarizeWithChoice } from "../src/compression/summarize.ts"
import { summaryChars, summaryGoal, summaryTitle } from "../src/compression/summary.ts"
import { validateSummary } from "../src/compression/validate.ts"

const markdown = `# 项目配置与压缩修复

## Goal
实现 Markdown 摘要模式，保留模型原始格式，同时让标题可以从正文派生。

## Constraints
- 不迁移旧状态
- 不做版本号

## Decisions
- JSON 与 Markdown 用 union 区分

## Progress
### Completed
- 完成 union 与 helpers

### Active
- 补 Markdown T1/T2

### Blocked
- (none)

## Open Items
- 本地 35B 验证

## Files
- src/compression/markdown.ts — 标题与解析

## Facts
- SUMMARY_WINDOW_RESERVE=10000
- summaryReserve(window)=min(10000, floor(window*0.25))
- 上下文 131072
`

describe("Markdown 摘要", () => {
  it("从第一个标题派生 title", () => {
    expect(deriveMarkdownTitle(markdown)).toBe("项目配置与压缩修复")
  })

  it("没有标题时取第一个非空行，并去掉 bullet", () => {
    expect(deriveMarkdownTitle("第一行正文\n第二行")).toBe("第一行正文")
    expect(deriveMarkdownTitle("- 列表标题\n正文")).toBe("列表标题")
  })

  it("标题最多 60 字符", () => {
    expect(deriveMarkdownTitle(`# ${"x".repeat(80)}`)).toHaveLength(60)
  })

  it("空文本返回 untitled", () => {
    expect(deriveMarkdownTitle("   ")).toBe("untitled")
  })

  it("goal 取标题后的第一段", () => {
    expect(markdownGoal(markdown)).toContain("实现 Markdown 摘要模式")
  })

  it("toMarkdownSummary 保留原文并支持显式标题", () => {
    const summary = toMarkdownSummary(markdown, "显式标题")
    expect(summary.format).toBe("markdown")
    expect(summary.title).toBe("显式标题")
    expect(summary.text).toBe(markdown.trim())
    expect(summaryTitle(summary)).toBe("显式标题")
    expect(summaryGoal(summary)).toContain("实现 Markdown 摘要模式")
    expect(summaryChars(summary)).toBe(markdown.trim().length)
  })

  it("去掉 markdown 代码围栏", () => {
    const summary = toMarkdownSummary("```markdown\n# 标题\n正文\n```")
    expect(summary.title).toBe("标题")
    expect(summary.text).toBe("# 标题\n正文")
  })

  it("toSummary 按 markdown 格式返回 MarkdownSummary", () => {
    const summary = toSummary(markdown, "markdown")
    expect(summary !== undefined && isMarkdownSummary(summary)).toBe(true)
  })

  it("renderSummary 直接返回 Markdown 原文", () => {
    const summary = toMarkdownSummary(markdown)
    expect(renderSummary(summary)).toBe(markdown.trim())
  })

  it("Markdown 校验检查标题与长度", () => {
    const summary = toMarkdownSummary(markdown)
    expect(validateSummary(summary, 10_000).ok).toBe(true)
    expect(validateSummary(toMarkdownSummary("太短"), 10_000).ok).toBe(false)
  })

  it("summarize 支持 markdown 模式", async () => {
    const result = await summarize({
      transcript: "x",
      sourceChars: 10_000,
      format: "markdown",
      generate: { text: () => Promise.resolve({ text: markdown }) },
    })
    expect(result !== undefined && isMarkdownSummary(result)).toBe(true)
    if (result !== undefined && isMarkdownSummary(result)) {
      expect(result.title).toBe("项目配置与压缩修复")
    }
  })

  it("T2 支持 candidate 行 + markdown 正文", async () => {
    const result = await summarizeWithChoice({
      context: markdown,
      task: "continue",
      candidates: [{ index: 1, description: "b1+b2 → T2", sourceChars: 10_000, tier: 2 }],
      format: "markdown",
      generate: {
        text: () => Promise.resolve({ text: `candidate: 1\n${markdown}` }),
      },
    })
    expect(result?.candidate.index).toBe(1)
    expect(result?.summary !== undefined && isMarkdownSummary(result.summary)).toBe(true)
  })

  it("Markdown 坏格式连续两次后第三次成功", async () => {
    let calls = 0
    const result = await summarize({
      transcript: "x",
      sourceChars: 10_000,
      format: "markdown",
      generate: {
        text: () => {
          calls += 1
          return Promise.resolve({ text: calls < 3 ? "not markdown" : markdown })
        },
      },
    })
    expect(calls).toBe(3)
    expect(result !== undefined && isMarkdownSummary(result)).toBe(true)
  })

  it("Markdown T2 坏格式连续两次后第三次成功", async () => {
    let calls = 0
    const result = await summarizeWithChoice({
      context: markdown,
      task: "continue",
      candidates: [{ index: 1, description: "b1+b2 → T2", sourceChars: 10_000, tier: 2 }],
      format: "markdown",
      generate: {
        text: () => {
          calls += 1
          return Promise.resolve({ text: calls < 3 ? "bad" : `candidate: 1\n${markdown}` })
        },
      },
    })
    expect(calls).toBe(3)
    expect(result?.candidate.index).toBe(1)
    expect(result?.summary !== undefined && isMarkdownSummary(result.summary)).toBe(true)
  })
})
