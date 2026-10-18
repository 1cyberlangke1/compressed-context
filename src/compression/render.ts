import type { Block } from "./state.ts"
import type { SummaryFields } from "./schema.ts"

/** 输入：块 id；输出：块头标记；预期：用于渲染和对账。 */
export function blockMarker(id: string): string {
  return `[Compressed conversation section #${id}]`
}

function bullets(items: readonly string[]): string {
  if (items.length === 0) return "- (none)"
  return items.map((item) => `- ${item}`).join("\n")
}

/** 输入：结构化字段；输出：Markdown 摘要正文。 */
export function renderSummary(summary: SummaryFields): string {
  return [
    "## Goal",
    summary.goal,
    "",
    "## Constraints",
    bullets(summary.constraints),
    "",
    "## Decisions",
    bullets(summary.decisions),
    "",
    "## Progress",
    "### Completed",
    bullets(summary.progress.completed),
    "### Active",
    bullets(summary.progress.active),
    "### Blocked",
    bullets(summary.progress.blocked),
    "",
    "## Open Items",
    bullets(summary.open_items),
    "",
    "## Files",
    bullets(summary.files),
    "",
    "## Facts",
    bullets(summary.facts),
  ].join("\n")
}

/** 输入：一个块；输出：带块头的完整文本。 */
export function renderBlock(block: Block): string {
  const title = block.summary.title.trim()
  const header = title ? `${blockMarker(block.id)} ${title}` : blockMarker(block.id)
  return `${header}\n\n${renderSummary(block.summary)}`
}

/** 输入：已落盘块 + 可选的 pending 块；输出：拼接后的 checkpoint 文本。 */
export function renderAll(blocks: readonly Block[], pending?: Block): string {
  const all = pending ? [...blocks, pending] : blocks
  return all.map(renderBlock).join("\n\n")
}
