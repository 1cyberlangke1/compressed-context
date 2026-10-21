import type { MarkdownSummary } from "./schema.ts"

const HEADING_RE = /^#{1,6}\s+(.+)$/m
const BULLET_RE = /^[\u2022\-*]\s+/

/** 输入：文本 + 上限；输出：截断后的文本。 */
function clamp(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max).trimEnd()
}

/**
 * 输入：Markdown 正文。
 * 输出：块标题；预期：第一个标题 > 第一个非空行 > untitled，去 bullet，最多 60 字符。
 */
export function deriveMarkdownTitle(text: string): string {
  const heading = HEADING_RE.exec(text)
  const source = heading !== null ? heading[1] ?? "" : (text.split("\n").find((line) => line.trim().length > 0) ?? "")
  const cleaned = source.trim().replace(BULLET_RE, "")
  return cleaned.length === 0 ? "untitled" : clamp(cleaned, 60)
}

/**
 * 输入：Markdown 正文。
 * 输出：用于候选描述的短目标；预期：标题后的第一个非空非标题行，最多 160 字符。
 */
export function markdownGoal(text: string): string {
  const lines = text.split("\n").map((line) => line.trim())
  const headingIndex = lines.findIndex((line) => HEADING_RE.test(line))
  const start = headingIndex >= 0 ? headingIndex + 1 : 0
  const first = lines.slice(start).find((line) => line.length > 0 && !HEADING_RE.test(line))
  const cleaned = (first ?? deriveMarkdownTitle(text)).replace(BULLET_RE, "")
  return clamp(cleaned, 160)
}

/** 输入：文本；输出：去掉 markdown 代码围栏后的正文。 */
function cleanMarkdown(text: string): string {
  return text
    .trim()
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim()
}

/** 输入：Markdown 正文 + 可选标题；输出：规范 Markdown 摘要。 */
export function toMarkdownSummary(text: string, title?: string): MarkdownSummary {
  const body = cleanMarkdown(text)
  const explicit = title?.trim() ?? ""
  return {
    format: "markdown",
    title: explicit.length > 0 ? clamp(explicit, 80) : deriveMarkdownTitle(body),
    text: body,
  }
}
