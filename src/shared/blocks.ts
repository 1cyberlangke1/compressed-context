/**
 * 摘要块的跨进程 DTO。
 *
 * 服务端把 active 链渲染成 body（markdown），TUI 只负责展示。
 */
export interface SummaryBlock {
  readonly id: string
  readonly tier: 1 | 2 | 3
  /** 摘要格式；Babel 正文不能按 Markdown 渲染。 */
  readonly format: "json" | "markdown" | "babel"
  readonly title: string
  readonly at: number
  readonly tokensBefore: number
  readonly tokensAfter: number
  readonly sourceBlockIds?: readonly string[]
  readonly body: string
}
