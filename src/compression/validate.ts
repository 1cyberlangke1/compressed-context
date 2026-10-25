import { isBabelSummary, isMarkdownSummary, type Summary } from "./schema.ts"
import { summaryChars } from "./summary.ts"

export const MIN_SUMMARY_CHARS = 200
export const MIN_MERGE_SUMMARY_CHARS = 80
export const MIN_ULTRA_SUMMARY_CHARS = 40
export const MAX_SUMMARY_CHARS = 20_000

/** 输入：层级；输出：该层允许的最短摘要字符数；tier≥3 都按 T3 的下限。 */
export function minSummaryChars(tier: number): number {
  if (tier >= 3) return MIN_ULTRA_SUMMARY_CHARS
  if (tier === 2) return MIN_MERGE_SUMMARY_CHARS
  return MIN_SUMMARY_CHARS
}
/** 可压缩原文的最小字符数，低于它不生成块。 */
export const MIN_SOURCE_CHARS = 5_000

export interface ValidationResult {
  readonly ok: boolean
  readonly fields: readonly string[]
  readonly message: string
}

/**
 * 输入：结构化摘要或 Markdown 摘要 + 原文总字符数。
 * 输出：校验结果。
 * 预期：JSON 检查字段；Markdown 检查标题/正文/长度，且摘要必须比原文小。
 */
export function validateSummary(
  summary: Summary,
  sourceChars: number,
  minChars: number = MIN_SUMMARY_CHARS,
  maxChars: number = MAX_SUMMARY_CHARS,
): ValidationResult {
  const fields: string[] = []
  if (isBabelSummary(summary)) {
    if (summary.title.trim().length === 0 || summary.title.length > 80) fields.push("title")
    if (summary.goal.trim().length === 0) fields.push("goal")
    const body = summary.text.split(/\r?\n/).slice(1).join("\n").trim()
    if (body.length === 0) fields.push("text")
  } else if (isMarkdownSummary(summary)) {
    if (summary.title.trim().length === 0 || summary.title.length > 80) fields.push("title")
    if (summary.text.trim().length === 0) fields.push("text")
  } else {
    if (summary.goal.trim().length === 0) fields.push("goal")
    if (summary.title.trim().length === 0 || summary.title.length > 80) fields.push("title")
    if (summary.constraints.some((item) => item.trim().length === 0)) fields.push("constraints")
    if (summary.decisions.some((item) => item.trim().length === 0)) fields.push("decisions")
    if (summary.open_items.some((item) => item.trim().length === 0)) fields.push("open_items")
    if (summary.files.some((item) => item.trim().length === 0)) fields.push("files")
    if (summary.facts.some((item) => item.trim().length === 0)) fields.push("facts")
  }

  if (fields.length > 0) {
    return { ok: false, fields, message: `empty field: ${fields.join(", ")}` }
  }

  const chars = summaryChars(summary)
  if (chars < minChars) {
    return {
      ok: false,
      fields: ["summary"],
      message: `summary too short (${chars.toString()} chars, min ${minChars.toString()})`,
    }
  }
  if (chars > maxChars) {
    return {
      ok: false,
      fields: ["summary"],
      message: `summary too long (${chars.toString()} chars, max ${maxChars.toString()})`,
    }
  }
  if (sourceChars > 0 && chars >= sourceChars) {
    return {
      ok: false,
      fields: ["summary"],
      message: `summary (${chars.toString()} chars) is not smaller than the source (${sourceChars.toString()} chars)`,
    }
  }
  return { ok: true, fields: [], message: "ok" }
}
