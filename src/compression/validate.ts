import type { SummaryFields } from "./schema.ts"

export const MIN_SUMMARY_CHARS = 200
export const MAX_SUMMARY_CHARS = 20_000
/** 可压缩原文的最小字符数，低于它不生成块。 */
export const MIN_SOURCE_CHARS = 5_000

export interface ValidationResult {
  readonly ok: boolean
  readonly fields: readonly string[]
  readonly message: string
}

/** 输入：结构化摘要；输出：估算字符数。 */
export function summaryChars(summary: SummaryFields): number {
  return JSON.stringify(summary).length
}

/**
 * 输入：结构化摘要 + 原文总字符数。
 * 输出：校验结果。
 * 预期：goal 非空、总长度在范围内、摘要必须比原文小。
 */
export function validateSummary(summary: SummaryFields, sourceChars: number): ValidationResult {
  const fields: string[] = []
  if (summary.goal.trim().length === 0) fields.push("goal")
  if (summary.constraints.some((item) => item.trim().length === 0)) fields.push("constraints")
  if (summary.decisions.some((item) => item.trim().length === 0)) fields.push("decisions")
  if (summary.open_items.some((item) => item.trim().length === 0)) fields.push("open_items")
  if (summary.files.some((item) => item.trim().length === 0)) fields.push("files")
  if (summary.facts.some((item) => item.trim().length === 0)) fields.push("facts")

  if (fields.length > 0) {
    return { ok: false, fields, message: `empty field: ${fields.join(", ")}` }
  }

  const chars = summaryChars(summary)
  if (chars < MIN_SUMMARY_CHARS) {
    return {
      ok: false,
      fields: ["summary"],
      message: `summary too short (${chars.toString()} chars, min ${MIN_SUMMARY_CHARS.toString()})`,
    }
  }
  if (chars > MAX_SUMMARY_CHARS) {
    return {
      ok: false,
      fields: ["summary"],
      message: `summary too long (${chars.toString()} chars, max ${MAX_SUMMARY_CHARS.toString()})`,
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
