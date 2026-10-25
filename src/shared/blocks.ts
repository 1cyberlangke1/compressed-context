/**
 * 摘要块的跨进程 DTO。
 *
 * 服务端把 active 链渲染成 body，TUI 只负责展示。
 */
export interface SummaryBlock {
  readonly id: string
  readonly tier: number
  /** 折叠深度：T1=1，合并块 = 1 + 子块最大深度；tier 封顶后仍会增长。 */
  readonly depth: number
  /** 摘要格式；Babel 正文不能按 Markdown 渲染。 */
  readonly format: "json" | "markdown" | "babel"
  readonly title: string
  readonly at: number
  readonly sourceTokens: number
  readonly summaryTokens: number
  readonly sourceBlockIds?: readonly string[]
  readonly body: string
}
