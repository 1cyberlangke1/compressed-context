import { describe, expect, it } from "vitest"

import { splitBabelCandidate, toBabelSummary } from "../src/compression/babel.ts"
import { toSummary } from "../src/compression/normalize.ts"
import { isBabelSummary, isMarkdownSummary } from "../src/compression/schema.ts"
import { parseState } from "../src/compression/state.ts"
import { buildMergeInstruction, buildT1Instruction } from "../src/compression/summarize.ts"
import { summaryBody, summaryChars, summaryGoal, summaryTitle } from "../src/compression/summary.ts"
import { validateSummary } from "../src/compression/validate.ts"

const VALID = "T=压缩插件|G=验证 Babel 格式\nD 新增 format=babel because Markdown 标签费 token\nF src/shared/settings.ts:22"

describe("toBabelSummary", () => {
  it("解析首行 T/G，并保留正文", () => {
    const summary = toBabelSummary(VALID)
    expect(summary).toBeDefined()
    expect(summary?.title).toBe("压缩插件")
    expect(summary?.goal).toBe("验证 Babel 格式")
    expect(summary?.text).toBe(VALID)
  })

  it("兼容两行 T/G 和代码围栏", () => {
    const summary = toBabelSummary("```babel\nT=标题\nG=目标\nD 正文\n```")
    expect(summary?.title).toBe("标题")
    expect(summary?.goal).toBe("目标")
    expect(summary?.text).toContain("D 正文")
    expect(summary?.text.startsWith("T=标题|G=目标")).toBe(true)
  })

  it("显式 title/goal 可以补无首行的正文", () => {
    const summary = toBabelSummary("D 正文没有首行", "标题", "目标")
    expect(summary?.text).toBe("T=标题|G=目标\nD 正文没有首行")
  })

  it("缺少标题、目标或正文时返回 undefined", () => {
    expect(toBabelSummary("D 只有正文")).toBeUndefined()
    expect(toBabelSummary("T=|G=目标\nD 正文")).toBeUndefined()
    expect(toBabelSummary("T=标题|G=\nD 正文")).toBeUndefined()
    expect(toBabelSummary("T=标题|G=目标")).toBeUndefined()
  })
})

describe("Babel summary helpers", () => {
  it("toSummary 按 babel 解析对象和字符串", () => {
    const fromString = toSummary(VALID, "babel")
    expect(fromString !== undefined && isBabelSummary(fromString)).toBe(true)
    const fromObject = toSummary({ format: "babel", babel: VALID }, "babel")
    expect(fromObject !== undefined && isBabelSummary(fromObject)).toBe(true)
    expect(fromObject !== undefined && isMarkdownSummary(fromObject)).toBe(false)
  })

  it("summaryBody/goal/title/chars 使用 Babel 字段", () => {
    const summary = toBabelSummary(VALID)
    expect(summary).toBeDefined()
    if (summary === undefined) return
    expect(summaryTitle(summary)).toBe("压缩插件")
    expect(summaryGoal(summary)).toBe("验证 Babel 格式")
    expect(summaryBody(summary)).toBe(VALID)
    expect(summaryChars(summary)).toBe(VALID.length)
  })

  it("validateSummary 接受合法 Babel，拒绝缺 goal 或空正文", () => {
    const summary = toBabelSummary(VALID)
    expect(summary).toBeDefined()
    if (summary === undefined) return
    expect(validateSummary(summary, 10_000, 40).ok).toBe(true)

    const noGoal = { ...summary, goal: "" }
    expect(validateSummary(noGoal, 10_000, 40).message).toContain("goal")

    const noBody = { ...summary, text: "T=标题|G=目标" }
    expect(validateSummary(noBody, 10_000, 40).message).toContain("text")
  })

  it("parseState 能反序列化 Babel 块", () => {
    const summary = toBabelSummary(VALID)
    expect(summary).toBeDefined()
    if (summary === undefined) return
    const state = parseState({
      blocks: [
        {
          id: "b1",
          tier: 1,
          summary,
          fromId: "m1",
          toId: "m2",
          tokensBefore: 100,
          tokensAfter: 10,
          at: 1,
          order: 1,
        },
      ],
      attempts: 0,
    })
    expect(state.blocks).toHaveLength(1)
    expect(state.blocks[0] !== undefined && isBabelSummary(state.blocks[0].summary)).toBe(true)
  })
})

describe("Babel candidate parsing", () => {
  it("接受 c=N 和 candidate: N", () => {
    expect(splitBabelCandidate("c=2\nT=标题|G=目标\nD 正文")).toEqual({
      candidate: 2,
      summary: "T=标题|G=目标\nD 正文",
    })
    expect(splitBabelCandidate("candidate: 1\nT=标题|G=目标\nD 正文")?.candidate).toBe(1)
  })

  it("没有候选行时返回 undefined", () => {
    expect(splitBabelCandidate(VALID)).toBeUndefined()
  })
})

describe("Babel prompts", () => {
  it("T1 和合并提示词都要求 T/G 首行", () => {
    const t1 = buildT1Instruction({ format: "babel", maxChars: 2_000 })
    expect(t1).toContain("T=<short title>|G=<one-line goal>")
    expect(t1).toContain("Babel")
    expect(t1).not.toContain("## Goal")

    const merge = buildMergeInstruction(
      [{ index: 1, description: "b1 + b2 → T2", sourceChars: 1_000, tier: 2 }],
      { format: "babel", maxChars: 2_000 },
    )
    expect(merge).toContain("c=N")
    expect(merge).toContain("T=<short title>|G=<one-line goal>")
    expect(merge).not.toContain("candidate: N")
  })

  it("Babel 只换书写方式，不比其他格式少保留内容", () => {
    const t1 = buildT1Instruction({ format: "babel", maxChars: 2_000 })
    expect(t1).toContain("changes only notation, not content")
    expect(t1).toContain("never round or estimate")
    // 文件清单和命令必须原样保留，不能被「各种文件」概括掉。
    expect(t1).toContain("Keep file lists complete")
    expect(t1).toContain("copy commands verbatim")
    // 不允许 babel 独有的 token 目标把内容压得比 markdown/json 更狠。
    expect(t1).not.toMatch(/Target \d+-\d+ tokens for T1/)

    const merge = buildMergeInstruction(
      [{ index: 1, description: "b1 + b2 → T2", sourceChars: 1_000, tier: 2 }],
      { format: "babel", maxChars: 2_000 },
    )
    expect(merge).toContain("changes only notation, not content")
    expect(merge).toContain("never round or estimate")
    expect(merge).not.toMatch(/Target \d+-\d+ tokens for T2/)
  })
})
