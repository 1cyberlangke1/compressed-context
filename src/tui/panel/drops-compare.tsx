/**
 * 缓存突变的完整对比视图。
 *
 * 左右两栏各自是独立的滚动容器，固定在弹窗内各占一半，始终同时可见：
 * 左边上一条、右边当前。每栏都有自己的横向和纵向滚动条，可以左右拖看超长行；
 * 行号跟在行首，相同绿色、不同红色，变化行带 `-`/`+`。
 * 完整报文直接内联在记录里，随记录一起按 maxRecords LRU 淘汰。
 */

import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, For, Show } from "solid-js"

import { resolveMessages } from "../../i18n/index.ts"
import type { CacheDrop } from "../../shared/cache-drops.ts"
import { diffLines, type LineDiffRow } from "../../shared/line-diff.ts"
import { prettyJsonLines } from "./drops-format.ts"

/** 对比视图最多渲染多少行；超大报文只展示前面一段，避免终端卡死。 */
const MAX_DIFF_ROWS = 4_000
/** 行号栏宽度（含末尾空格）。 */
const GUTTER = 5
/** 宿主 xlarge 弹窗的固定宽度；超过终端宽度时按终端收窄。 */
const DIALOG_WIDTH = 116

/** 输入：行号；输出：固定宽度的行号文本。 */
function lineNo(no: number | undefined): string {
  return no === undefined ? "" : no.toString().padStart(GUTTER - 1, " ")
}

/**
 * 输入：TUI 上下文 + 会话 + 记录 + 文案 + 返回回调。
 * 输出：占满弹窗的对比界面。
 * 预期：直接读记录里内联的完整报文；左右两栏各自带滚动条、同时可见；
 *       旧记录没有内联报文时退回记录里的断点摘录。
 */
export function DropCompare(props: {
  readonly context: Context
  readonly sessionID: string
  readonly drop: CacheDrop
  readonly copy: ReturnType<typeof resolveMessages>
  readonly onBack: () => void
}) {
  const theme = props.context.theme

  const viewportHeight = createMemo(() => {
    const height = props.context.renderer.height
    return Number.isFinite(height) && height > 0 ? height : 40
  })

  /** 有内联报文就对比整份报文；旧记录退回记录里的摘录。 */
  const leftSource = createMemo(() => props.drop.bodies?.previousBody ?? props.drop.breakPoint?.before)
  const rightSource = createMemo(() => props.drop.bodies?.body ?? props.drop.breakPoint?.after)
  const rows = createMemo<readonly LineDiffRow[]>(() => {
    const left = leftSource()
    const right = rightSource()
    if (left === undefined || right === undefined) return []
    return diffLines(prettyJsonLines(left).join("\n"), prettyJsonLines(right).join("\n"))
  })
  const visibleRows = createMemo(() => rows().slice(0, MAX_DIFF_ROWS))
  /**
   * 两栏各自最长行的码点宽度。
   * 预期：行盒必须显式给宽；不给宽会被滚动视口拉伸成等宽，`scrollWidth` 等于视口，横向就没有可滚范围。
   */
  const columnContentWidth = createMemo(() => {
    let left = 1
    let right = 1
    for (const row of visibleRows()) {
      if (row.left !== undefined) left = Math.max(left, Array.from(row.left.text).length)
      if (row.right !== undefined) right = Math.max(right, Array.from(row.right.text).length)
    }
    return { left, right }
  })
  /**
   * 弹窗固定高度：按终端高度放大，但始终比终端矮两行。
   * 预期：centered 弹窗上下各留一行，标题行（含 esc）不会被裁到终端外。
   */
  const fixedHeight = createMemo(() => Math.max(10, Math.min(60, viewportHeight() - 2, Math.floor(viewportHeight() * 0.85))))
  /**
   * 内容区高度：标题行、列头行、截断警告行和三道 gap 之外剩余的部分。
   * 预期：标题行钉死一行且 flexShrink=0，内容多时不会被 flex 压扁；esc 恒在标题行最右。
   */
  const panelHeight = createMemo(() => Math.max(4, fixedHeight() - 6))

  /** 弹窗实际可用宽度：xlarge 固定 116，终端更窄时收窄，再减左右内边距。 */
  const dialogWidth = createMemo(() => {
    const terminal = props.context.renderer.width
    const limit = Number.isFinite(terminal) && terminal > 0 ? terminal - 2 : DIALOG_WIDTH
    return Math.max(40, Math.min(DIALOG_WIDTH, limit) - 6)
  })
  /** 每栏宽度：弹窗一半减去中间分隔线。 */
  const columnWidth = createMemo(() => Math.max(20, Math.floor((dialogWidth() - 1) / 2)))

  /** 输入：行；输出：该行颜色。预期：相同绿色、不同红色。 */
  const rowColor = (row: LineDiffRow): Context["theme"]["text"]["base"] =>
    row.kind === "same" ? theme.text.feedback.success.base : theme.text.feedback.error.base

  /** 输入：行；输出：左/右标记。预期：变化行用 `-`/`+`，相同行留空。 */
  const marker = (row: LineDiffRow, side: "left" | "right"): string => {
    if (row.kind === "same") return " "
    if (side === "left") return row.left === undefined ? " " : "-"
    return row.right === undefined ? " " : "+"
  }

  /** 输入：栏；输出：该栏的逐行元素。预期：行号 + 标记 + 内容都在同一个横向滚动区里，行宽按最长行显式声明。 */
  const Column = (input: { readonly side: "left" | "right" }) => {
    const contentWidth = createMemo(() =>
      input.side === "left" ? columnContentWidth().left : columnContentWidth().right,
    )
    return (
      <scrollbox
        width={columnWidth()}
        height={panelHeight()}
        scrollX={true}
        scrollY={true}
        focused={true}
        flexShrink={0}
        contentOptions={{ width: "auto" }}
      >
        <For each={visibleRows()}>
          {(row) => (
            <box flexDirection="row" height={1} flexShrink={0} width={GUTTER + 1 + contentWidth()}>
              <text fg={theme.text.muted} width={GUTTER} flexShrink={0} selectable={false}>
                {lineNo(input.side === "left" ? row.left?.no : row.right?.no)}
              </text>
              <text fg={rowColor(row)} width={1} flexShrink={0} selectable={false}>
                {marker(row, input.side)}
              </text>
              <text fg={rowColor(row)} width={contentWidth()} flexShrink={0} wrapMode="none" selectable={false}>
                {input.side === "left" ? (row.left?.text ?? "") : (row.right?.text ?? "")}
              </text>
            </box>
          )}
        </For>
      </scrollbox>
    )
  }

  return (
    <box flexDirection="column" width="100%" height={fixedHeight()} flexShrink={0} gap={1}>
      <box flexDirection="row" height={1} flexShrink={0} flexWrap="no-wrap">
        <text fg={theme.text.base} wrapMode="none" flexShrink={0}>
          {`${props.copy.drops.compareTitle}  -${props.drop.dropPp.toFixed(1)}pp  ·  ${props.copy.drops.kind[props.drop.kind ?? "unknown"]}  ·  ${props.copy.drops.causeIcon[props.drop.cause]} ${props.copy.drops.cause[props.drop.cause]}  ·  `}
        </text>
        <box onMouseUp={props.onBack}>
          <text fg={theme.text.muted} wrapMode="none">
            {props.copy.drops.closeLabel}
          </text>
        </box>
      </box>

      <Show
        when={rows().length > 0}
        fallback={<text fg={theme.text.feedback.warning.base}>{props.copy.drops.fileMissing}</text>}
      >
        <box flexDirection="row" gap={1} height={1}>
          <text fg={theme.text.feedback.success.base} width={columnWidth()} flexShrink={0}>
            {props.copy.drops.prevColumn}
          </text>
          <text fg={theme.text.muted} width={1} flexShrink={0}>
            {"│"}
          </text>
          <text fg={theme.text.feedback.success.base} flexShrink={0}>
            {props.copy.drops.curColumn}
          </text>
        </box>
        <box flexDirection="row" gap={1} height={panelHeight()} flexShrink={0}>
          <Column side="left" />
          <text fg={theme.text.muted} width={1} flexShrink={0} wrapMode="none">
            {"│\n".repeat(Math.max(1, panelHeight())).trimEnd()}
          </text>
          <Column side="right" />
        </box>
        <Show when={rows().length > MAX_DIFF_ROWS}>
          <text fg={theme.text.feedback.warning.base} height={1} flexShrink={0}>
            {`${MAX_DIFF_ROWS.toString()} / ${rows().length.toString()}`}
          </text>
        </Show>
      </Show>
    </box>
  )
}
