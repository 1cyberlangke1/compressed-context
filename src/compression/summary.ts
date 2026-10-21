import { isMarkdownSummary, type Summary, type SummaryFields } from "./schema.ts"
import { markdownGoal } from "./markdown.ts"

/** 输入：条目；输出：Markdown 列表；空列表输出 `- (none)`。 */
function bullets(items: readonly string[]): string {
  if (items.length === 0) return "- (none)"
  return items.map((item) => `- ${item}`).join("\n")
}

/** 输入：JSON 摘要字段；输出：Markdown 正文。 */
export function renderFields(fields: SummaryFields): string {
  return [
    "## Goal",
    fields.goal,
    "",
    "## Constraints",
    bullets(fields.constraints),
    "",
    "## Decisions",
    bullets(fields.decisions),
    "",
    "## Progress",
    "### Completed",
    bullets(fields.progress.completed),
    "### Active",
    bullets(fields.progress.active),
    "### Blocked",
    bullets(fields.progress.blocked),
    "",
    "## Open Items",
    bullets(fields.open_items),
    "",
    "## Files",
    bullets(fields.files),
    "",
    "## Facts",
    bullets(fields.facts),
  ].join("\n")
}

/** 输入：摘要；输出：块标题。 */
export function summaryTitle(summary: Summary): string {
  return summary.title
}

/** 输入：摘要；输出：用于候选描述的短目标。 */
export function summaryGoal(summary: Summary): string {
  return isMarkdownSummary(summary) ? markdownGoal(summary.text) : summary.goal
}

/** 输入：摘要；输出：渲染后的正文。 */
export function summaryBody(summary: Summary): string {
  return isMarkdownSummary(summary) ? summary.text : renderFields(summary)
}

/** 输入：摘要；输出：正文实际字符数。 */
export function summaryChars(summary: Summary): number {
  if (isMarkdownSummary(summary)) return summary.text.length
  return [
    summary.title,
    summary.goal,
    ...summary.constraints,
    ...summary.decisions,
    ...summary.progress.completed,
    ...summary.progress.active,
    ...summary.progress.blocked,
    ...summary.open_items,
    ...summary.files,
    ...summary.facts,
  ].join("\n").length
}
