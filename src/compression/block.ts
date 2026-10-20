import type { SummaryFields } from "./schema.ts"
import { nextBlockId, nextOrder, type Block } from "./state.ts"

/** 输入：已有块 + 摘要 + 覆盖范围 + 原文字符数；输出：新的 T1 块。 */
export function createT1Block(input: {
  readonly blocks: readonly Block[]
  readonly summary: SummaryFields
  readonly fromId: string
  readonly toId: string
  readonly sourceChars: number
  readonly at?: number
}): Block {
  return {
    id: nextBlockId(input.blocks),
    tier: 1,
    summary: input.summary,
    fromId: input.fromId,
    toId: input.toId,
    tokensBefore: Math.ceil(input.sourceChars / 4),
    tokensAfter: Math.ceil(JSON.stringify(input.summary).length / 4),
    at: input.at ?? Date.now(),
    order: nextOrder(input.blocks),
  }
}
