import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import { normalizeSummary, toSummary } from "../src/compression/normalize.ts"
import { isMarkdownSummary, SummaryInput, type Summary, type SummaryFields } from "../src/compression/schema.ts"

/** 输入：摘要；输出：JSON 字段；Markdown 返回 undefined。 */
function jsonSummary(summary: Summary | undefined): SummaryFields | undefined {
  return summary !== undefined && !isMarkdownSummary(summary) ? summary : undefined
}

describe("summary normalization", () => {
  it("只给 goal 时补齐空字段并从 goal 派生 title", () => {
    const summary = jsonSummary(toSummary({ goal: "ship the plugin" }))
    expect(summary).toBeDefined()
    expect(summary?.title).toBe("ship the plugin")
    expect(summary?.constraints).toEqual([])
    expect(summary?.decisions).toEqual([])
    expect(summary?.progress).toEqual({ completed: [], active: [], blocked: [] })
    expect(summary?.open_items).toEqual([])
    expect(summary?.files).toEqual([])
    expect(summary?.facts).toEqual([])
  })

  it("保留模型显式给出的可选字段", () => {
    const summary = jsonSummary(
      toSummary({
        goal: "g",
        files: ["src/index.ts:1 — wiring"],
        facts: "one fact",
        progress: { completed: ["done"] },
      }),
    )
    expect(summary?.files).toEqual(["src/index.ts:1 — wiring"])
    expect(summary?.facts).toEqual(["one fact"])
    expect(summary?.progress).toEqual({ completed: ["done"], active: [], blocked: [] })
  })

  it("SummaryInput 只要求 goal，允许省略其余字段", () => {
    const input = Schema.decodeUnknownSync(SummaryInput)({ goal: "g" })
    expect(input.goal).toBe("g")
    expect(input.files).toBeUndefined()
    expect(input.progress).toBeUndefined()
  })

  it("JSON 模式非对象返回 undefined；Markdown 模式接受字符串", () => {
    expect(toSummary("not an object", "json")).toBeUndefined()
    const markdown = toSummary("not an object", "markdown")
    expect(markdown !== undefined && isMarkdownSummary(markdown)).toBe(true)
    expect(normalizeSummary("not an object")).toBe("not an object")
  })
})
