import { describe, expect, test } from "vitest"

import { editBlock } from "../src/compression/block-edit.ts"
import { renderAll } from "../src/compression/render.ts"
import type { BabelSummary, MarkdownSummary } from "../src/compression/schema.ts"
import type { Block, State } from "../src/compression/state.ts"

/** 输入：标题/目标/正文；输出：合法的 Babel 摘要。 */
function babel(title: string, goal: string, body: string): BabelSummary {
  return { format: "babel", title, goal, text: `T=${title}|G=${goal}\n${body}` }
}

/** 输入：覆盖字段；输出：一个 T1 块。预期：拓扑字段固定，只有 summary 可变。 */
function block(overrides?: Partial<Block>): Block {
  return {
    id: "b1",
    tier: 1,
    height: 1,
    summary: babel("旧标题", "旧目标", "S[mod]:old"),
    fromId: "m1",
    toId: "m2",
    sourceTokens: 5000,
    summaryTokens: 30,
    at: 1000,
    order: 1,
    ...overrides,
  }
}

/** 输入：块列表；输出：状态。 */
function state(blocks: readonly Block[], pending?: Block): State {
  return { blocks, attempts: 0, ...(pending === undefined ? {} : { pending }) }
}

/** 输入：状态 + 覆盖字段；输出：编辑请求。预期：默认放大上限，只测逻辑本身。 */
function request(overrides?: {
  readonly state?: State
  readonly blockID?: string
  readonly expectedAt?: number
  readonly text?: string
  readonly blockChars?: number
  readonly totalChars?: number
}) {
  const current = overrides?.state ?? state([block()])
  return {
    state: current,
    blockID: overrides?.blockID ?? "b1",
    expectedAt: overrides?.expectedAt ?? 1000,
    text: overrides?.text ?? "T=新标题|G=新目标\nS[mod]:new",
    blockChars: overrides?.blockChars ?? 20000,
    totalChars: overrides?.totalChars ?? 20000,
    render: {},
  }
}

describe("editBlock", () => {
  test("原地替换正文，拓扑字段一个都不动", () => {
    const outcome = editBlock(request())
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const edited = outcome.state.blocks[0]
    expect(edited?.summary).toMatchObject({ format: "babel", title: "新标题", goal: "新目标" })
    expect(edited?.tier).toBe(1)
    expect(edited?.height).toBe(1)
    expect(edited?.fromId).toBe("m1")
    expect(edited?.toId).toBe("m2")
    expect(edited?.sourceTokens).toBe(5000)
    expect(edited?.at).toBe(1000)
    expect(edited?.order).toBe(1)
  })

  test("summaryTokens 跟着正文重算", () => {
    const outcome = editBlock(request({ text: `T=新|G=新\n${"S[mod]:x ".repeat(40)}` }))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.state.blocks[0]?.summaryTokens).toBeGreaterThan(30)
  })

  test("首行缺 T=|G= 时拒绝", () => {
    const outcome = editBlock(request({ text: "没有首行的正文" }))
    expect(outcome).toEqual({ ok: false, code: "badHeader" })
  })

  test("正文为空时拒绝", () => {
    const outcome = editBlock(request({ text: "T=标题|G=目标\n" }))
    expect(outcome).toEqual({ ok: false, code: "badHeader" })
  })

  test("超过单块字符上限时拒绝并带回数字", () => {
    const outcome = editBlock(request({ blockChars: 10 }))
    expect(outcome).toMatchObject({ ok: false, code: "tooLong", b: "10" })
  })

  test("摘要不小于原文时拒绝", () => {
    const outcome = editBlock({
      ...request(),
      state: state([block({ sourceTokens: 3 })]),
    })
    expect(outcome).toMatchObject({ ok: false, code: "notSmaller", b: "3" })
  })

  test("整链超预算时拒绝", () => {
    const outcome = editBlock(request({ totalChars: 1 }))
    expect(outcome).toMatchObject({ ok: false, code: "chainBudget", b: "1" })
  })

  test("压缩进行中（有 pending）时拒绝", () => {
    const pending = block({ id: "b2", at: 2000, order: 2 })
    const outcome = editBlock(request({ state: state([block()], pending) }))
    expect(outcome).toEqual({ ok: false, code: "compacting" })
  })

  test("块已被合并时拒绝", () => {
    const parent = block({ id: "b2", tier: 2, height: 2, at: 2000, order: 1, sourceBlockIds: ["b1"] })
    const outcome = editBlock(request({ state: state([block(), parent]) }))
    expect(outcome).toEqual({ ok: false, code: "merged" })
  })

  test("expectedAt 对不上时拒绝（块已被换过）", () => {
    const outcome = editBlock(request({ expectedAt: 999 }))
    expect(outcome).toEqual({ ok: false, code: "stale" })
  })

  test("块不存在时拒绝", () => {
    const outcome = editBlock(request({ blockID: "b9" }))
    expect(outcome).toEqual({ ok: false, code: "notFound" })
  })

  test("旧 JSON 块不提供编辑", () => {
    const jsonBlock = block({
      summary: {
        title: "旧",
        goal: "旧目标",
        constraints: [],
        decisions: [],
        progress: { completed: [], active: [], blocked: [] },
        open_items: [],
        files: [],
        facts: [],
      },
    })
    const outcome = editBlock(request({ state: state([jsonBlock]) }))
    expect(outcome).toEqual({ ok: false, code: "legacyJson" })
  })

  test("Markdown 块按 Markdown 解析并重新取标题", () => {
    const markdown: MarkdownSummary = { format: "markdown", title: "旧", text: "# 旧\n- x" }
    const outcome = editBlock(
      request({ state: state([block({ summary: markdown })]), text: "# 新标题\n- y" }),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.state.blocks[0]?.summary).toMatchObject({
      format: "markdown",
      title: "新标题",
      text: "# 新标题\n- y",
    })
  })

  test("NUL 字符直接拒绝", () => {
    const outcome = editBlock(request({ text: "T=a|G=b\nx\u0000y" }))
    expect(outcome).toEqual({ ok: false, code: "nul" })
  })

  test("返回的新状态能被 renderAll 正常渲染", () => {
    const outcome = editBlock(request())
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const text = renderAll(outcome.state.blocks)
    expect(text).toContain("新标题")
    expect(text).toContain("S[mod]:new")
  })
})
