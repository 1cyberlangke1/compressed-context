import type { Summary } from "./schema.ts"
import { summaryChars } from "./summary.ts"
import { nextBlockId, nextOrder, type Block } from "./state.ts"

/** 输入：已有块 + 摘要 + 覆盖范围 + 原文字符数；输出：新的 T1 块。 */
export function createT1Block(input: {
  readonly blocks: readonly Block[]
  readonly summary: Summary
  readonly fromId: string
  readonly toId: string
  readonly sourceChars: number
  readonly at?: number
}): Block {
  return {
    id: nextBlockId(input.blocks),
    tier: 1,
    height: 1,
    summary: input.summary,
    fromId: input.fromId,
    toId: input.toId,
    sourceTokens: Math.ceil(input.sourceChars / 4),
    summaryTokens: Math.ceil(summaryChars(input.summary) / 4),
    at: input.at ?? Date.now(),
    order: nextOrder(input.blocks),
  }
}
