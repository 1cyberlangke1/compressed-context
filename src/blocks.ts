/**
 * 摘要块的跨进程 DTO。
 *
 * 服务端把 active 链渲染成 body（markdown），TUI 只负责展示。
 */
export interface SummaryBlock {
  readonly id: string
  readonly tier: 1 | 2 | 3
  readonly title: string
  readonly at: number
  readonly tokensBefore: number
  readonly tokensAfter: number
  readonly sourceBlockIds?: readonly string[]
  readonly body: string
}
