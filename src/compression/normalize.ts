import { Schema } from "effect"

import type { SummaryFormat } from "../shared/settings.ts"
import { toMarkdownSummary } from "./markdown.ts"
import { SummaryFields, type Summary } from "./schema.ts"

/** 输入：任意模型字段；输出：字符串数组；预期：字符串包成单元素数组，其他丢弃。 */
export function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
  }
  if (typeof value === "string" && value.trim().length > 0) return [value]
  return []
}

/**
 * 输入：模型返回的原始 JSON 对象。
 * 输出：补齐缺失可选字段后的对象。
 * 预期：真实模型常漏 progress/files 或把数组写成字符串；只补空值，不编造内容。
 */
export function normalizeSummary(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value
  const record = value as Record<string, unknown>
  const goal = typeof record["goal"] === "string" ? record["goal"] : ""
  const title = (
    typeof record["title"] === "string" && record["title"].trim().length > 0
      ? record["title"]
      : goal.trim() || "untitled"
  ).slice(0, 80)
  const progress =
    typeof record["progress"] === "object" && record["progress"] !== null
      ? (record["progress"] as Record<string, unknown>)
      : {}
  return {
    ...record,
    title,
    goal,
    constraints: stringArray(record["constraints"]),
    decisions: stringArray(record["decisions"]),
    progress: {
      completed: stringArray(progress["completed"]),
      active: stringArray(progress["active"]),
      blocked: stringArray(progress["blocked"]),
    },
    open_items: stringArray(record["open_items"]),
    files: stringArray(record["files"]),
    facts: stringArray(record["facts"]),
  }
}

/** 输入：模型返回的 Markdown 载体；输出：正文；预期：支持 string / markdown / text / summary。 */
function markdownText(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  for (const key of ["markdown", "text", "summary", "content"]) {
    const text = record[key]
    if (typeof text === "string") return text
  }
  return undefined
}

/** 输入：模型返回的 Markdown 载体；输出：可选标题。 */
function markdownTitle(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const title = record["title"] ?? record["topic"]
  return typeof title === "string" ? title : undefined
}

/**
 * 输入：模型返回的原始值 + 摘要格式。
 * 输出：规范摘要；形状不合法时返回 undefined。
 * 预期：Markdown 直接保留原文；JSON 先补齐可选字段再由 SummaryFields 解码。
 */
export function toSummary(value: unknown, format: SummaryFormat = "markdown"): Summary | undefined {
  if (format === "markdown") {
    const text = markdownText(value)
    if (text !== undefined) return toMarkdownSummary(text, markdownTitle(value))
    // Markdown 模式下仍收到 JSON 字段时回退到结构化解析，避免工具调用直接失败。
  }
  try {
    return Schema.decodeUnknownSync(SummaryFields)(normalizeSummary(value))
  } catch {
    return undefined
  }
}
