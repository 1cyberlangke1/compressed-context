import type { Block } from "./state.ts"
import type { Summary } from "./schema.ts"
import { summaryBody, summaryTitle } from "./summary.ts"
import { formatTimestamp } from "../shared/format.ts"
import { countText } from "../shared/tokens.ts"

/** 输入：块 id；输出：块头标记；预期：用于渲染和对账。 */
export function blockMarker(id: string): string {
  return `[Compressed conversation section #${id}]`
}

/** 块头附加信息开关；默认都不显示，避免多占 token。 */
export interface RenderOptions {
  readonly showTimeline?: boolean
  readonly showBlockTokens?: boolean
}

/** 输入：结构化字段；输出：Markdown 摘要正文。 */
export function renderSummary(summary: Summary): string {
  return summaryBody(summary)
}

/**
 * 输入：一个块 + 可选渲染开关。
 * 输出：带块头、层级/合并关系、可选时间与 token 估算的完整文本。
 * 预期：marker 前缀保持原样，对账逻辑只依赖 `blockMarker(id)`。
 */
export function renderBlock(block: Block, options: RenderOptions = {}): string {
  const body = renderSummary(block.summary)
  // 层号放方括号，树高放花括号紧跟其后：`[T2] {h6}`，两者不混在一起。
  const tag = `[T${block.tier.toString()}] {h${block.height.toString()}}`
  const extras: string[] = []
  if (block.sourceBlockIds !== undefined && block.sourceBlockIds.length > 0) {
    extras.push(`merged ${block.sourceBlockIds.map((id) => `#${id}`).join(" + ")}`)
  }
  if (options.showBlockTokens === true) {
    extras.push(`≈${countText(body).toString()} tok`)
  }
  if (options.showTimeline === true) {
    extras.push(formatTimestamp(block.at))
  }
  const title = summaryTitle(block.summary).trim()
  const meta = extras.length === 0 ? tag : `${tag} · ${extras.join(" · ")}`
  const header = `${blockMarker(block.id)} ${meta}${title ? ` ${title}` : ""}`
  return `${header}\n\n${body}`
}

/**
 * 输入：已落盘块 + 可选 pending 块 + 渲染开关。
 * 输出：active 顶层块，按 order 排序。
 * 预期：被任何块 sourceBlockIds 引用的块不显示；合并块占据第一个源块的位置。
 */
export function activeBlocks(blocks: readonly Block[], pending?: Block): readonly Block[] {
  const all = pending === undefined ? blocks : [...blocks, pending]
  const consumed = new Set<string>()
  for (const block of all) {
    for (const sourceId of block.sourceBlockIds ?? []) consumed.add(sourceId)
  }
  return all
    .filter((block) => !consumed.has(block.id))
    .sort((a, b) => a.order - b.order || a.at - b.at || a.id.localeCompare(b.id))
}

/** 输入：块 + 可选 pending + 渲染开关；输出：拼接后的 checkpoint 文本。 */
export function renderAll(
  blocks: readonly Block[],
  pending?: Block,
  options: RenderOptions = {},
): string {
  return activeBlocks(blocks, pending)
    .map((block) => renderBlock(block, options))
    .join("\n\n")
}
