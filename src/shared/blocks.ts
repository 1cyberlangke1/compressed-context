/**
 * 摘要块的跨进程 DTO。
 *
 * 服务端把 active 链渲染成 body，TUI 只负责展示。
 */
export interface SummaryBlock {
  readonly id: string
  readonly tier: number
  /** 折叠深度：T1=1，合并块 = 1 + 子块最大深度；tier 封顶后仍会增长。 */
  readonly height: number
  /** 摘要格式；Babel 正文不能按 Markdown 渲染。 */
  readonly format: "json" | "markdown" | "babel"
  readonly title: string
  readonly at: number
  readonly sourceTokens: number
  readonly summaryTokens: number
  /** 子块 id 清单；连续来源会改用 sourceRange 存。 */
  readonly sourceBlockIds?: readonly string[]
  /** 连续子块的端点；与 sourceBlockIds 二选一。 */
  readonly sourceRange?: { readonly first: string; readonly last: string }
  readonly body: string
}

/** 输入：块 id；输出：数字部分；不是 `b<数字>` 时 undefined。 */
export function idNumber(id: string): number | undefined {
  if (!id.startsWith("b")) return undefined
  const value = Number(id.slice(1))
  return Number.isInteger(value) && value >= 0 ? value : undefined
}

/**
 * 输入：含 `sourceBlockIds` 或 `sourceRange` 的块。
 * 输出：展开后的完整子块 id 列表。
 * 预期：两种存法都归一成同一个列表，调用方不用关心存的是哪一种。
 */
export function expandSourceIds(block: {
  readonly sourceBlockIds?: readonly string[] | undefined
  readonly sourceRange?: { readonly first: string; readonly last: string } | undefined
}): readonly string[] {
  if (block.sourceBlockIds !== undefined) return block.sourceBlockIds
  const range = block.sourceRange
  if (range === undefined) return []
  const from = idNumber(range.first)
  const to = idNumber(range.last)
  if (from === undefined || to === undefined || to < from) return []
  return Array.from({ length: to - from + 1 }, (_, index) => `b${(from + index).toString()}`)
}

/**
 * 输入：子块 id 列表。
 * 输出：按连续段分组的紧凑文本，如 `#b34…#b50 + #b52…#b77`。
 * 预期：连续段（数字相邻）压成端点；单点保留 `#b3`；段间用 ` + `；
 *       非 `b<数字>` 的 id 原样单独成段，不参与合并。
 */
export function formatSourceSegments(ids: readonly string[]): string {
  const numbers: number[] = []
  const others: string[] = []
  for (const id of ids) {
    const value = idNumber(id)
    if (value === undefined) others.push(id)
    else numbers.push(value)
  }
  const sorted = [...numbers].sort((left, right) => left - right)
  const segments: string[] = []
  let start: number | undefined
  let end: number | undefined
  /** 输入：无；输出：把当前连续段写进 segments 并清空游标。 */
  const flush = (): void => {
    if (start === undefined) return
    const last = end ?? start
    segments.push(start === last ? `#b${start.toString()}` : `#b${start.toString()}…#b${last.toString()}`)
    start = undefined
    end = undefined
  }
  for (const value of sorted) {
    if (start === undefined) {
      start = value
      end = value
      continue
    }
    if (end !== undefined && value === end + 1) {
      end = value
      continue
    }
    flush()
    start = value
    end = value
  }
  flush()
  for (const id of others) segments.push(`#${id}`)
  return segments.join(" + ")
}


