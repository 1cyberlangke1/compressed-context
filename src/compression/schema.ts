import { Schema } from "effect"

import type { SummaryFormat } from "../shared/settings.ts"

/**
 * 摘要的规范 JSON 形状：写入存储、渲染、校验都用这一份，所有字段必填。
 *
 * 模型侧输入用 SummaryInput：JSON 模式只要求 goal，Markdown 模式要求 markdown；
 * 进入内部前由 normalize 补齐，避免逼模型编造内容。
 */
export const SummaryFields = Schema.Struct({
  title: Schema.String,
  goal: Schema.String,
  constraints: Schema.Array(Schema.String),
  decisions: Schema.Array(Schema.String),
  progress: Schema.Struct({
    completed: Schema.Array(Schema.String),
    active: Schema.Array(Schema.String),
    blocked: Schema.Array(Schema.String),
  }),
  open_items: Schema.Array(Schema.String),
  files: Schema.Array(Schema.String),
  facts: Schema.Array(Schema.String),
})

export type SummaryFields = Schema.Schema.Type<typeof SummaryFields>

/** Markdown 摘要：正文是唯一权威内容，title 只是派生元数据。 */
export interface MarkdownSummary {
  readonly format: "markdown"
  readonly title: string
  readonly text: string
}

/**
 * Babel 摘要：正文是模型间高密度文本，title/goal 从首行 `T=...|G=...` 解析。
 * text 保留首行，方便 T2/T3 合并时继续看到目标。
 */
export interface BabelSummary {
  readonly format: "babel"
  readonly title: string
  readonly goal: string
  readonly text: string
}

/** 块摘要：JSON 保持原形状，Markdown/Babel 用 format 标记；旧 JSON 块天然兼容。 */
export type Summary = SummaryFields | MarkdownSummary | BabelSummary

/** 输入：任意摘要；输出：是否 Markdown 摘要。 */
export function isMarkdownSummary(summary: Summary): summary is MarkdownSummary {
  return "format" in summary && summary.format === "markdown"
}

/** 输入：任意摘要；输出：是否 Babel 摘要。 */
export function isBabelSummary(summary: Summary): summary is BabelSummary {
  return "format" in summary && summary.format === "babel"
}

/**
 * 模型侧摘要输入：JSON 字段都可选，Markdown 用 markdown 字段。
 *
 * 预期：JSON 模式在归一化时要求 goal；Markdown 模式要求 markdown。
 */
export const SummaryInput = Schema.Struct({
  format: Schema.optional(
    Schema.Union([Schema.Literal("json"), Schema.Literal("markdown"), Schema.Literal("babel")]),
  ),
  markdown: Schema.optional(Schema.String),
  babel: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  goal: Schema.optional(Schema.String),
  constraints: Schema.optional(Schema.Array(Schema.String)),
  decisions: Schema.optional(Schema.Array(Schema.String)),
  progress: Schema.optional(
    Schema.Struct({
      completed: Schema.optional(Schema.Array(Schema.String)),
      active: Schema.optional(Schema.Array(Schema.String)),
      blocked: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  open_items: Schema.optional(Schema.Array(Schema.String)),
  files: Schema.optional(Schema.Array(Schema.String)),
  facts: Schema.optional(Schema.Array(Schema.String)),
})

export type SummaryInput = Schema.Schema.Type<typeof SummaryInput>

/**
 * JSON 模式的模型输入：goal 必填，其余可选。
 *
 * 与 SummaryInput 的差别只有 goal：JSON 模式没有 goal 就没有内容可写。
 */
export const JsonSummaryInput = Schema.Struct({
  goal: Schema.String,
  title: Schema.optional(Schema.String),
  constraints: Schema.optional(Schema.Array(Schema.String)),
  decisions: Schema.optional(Schema.Array(Schema.String)),
  progress: Schema.optional(
    Schema.Struct({
      completed: Schema.optional(Schema.Array(Schema.String)),
      active: Schema.optional(Schema.Array(Schema.String)),
      blocked: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  open_items: Schema.optional(Schema.Array(Schema.String)),
  files: Schema.optional(Schema.Array(Schema.String)),
  facts: Schema.optional(Schema.Array(Schema.String)),
})

/** Markdown 模式的模型输入：正文必填；title 可选，传了就省掉从首行提取。 */
export const MarkdownSummaryInput = Schema.Struct({
  markdown: Schema.String,
  title: Schema.optional(Schema.String),
})

/** Babel 模式的模型输入：正文必填；title 可选，目标从首行 `G=` 解析。 */
export const BabelSummaryInput = Schema.Struct({
  babel: Schema.String,
  title: Schema.optional(Schema.String),
})

/**
 * 输入：摘要格式。
 * 输出：该格式的模型输入 schema，只保留这个格式用得上的字段。
 * 预期：切换格式后工具参数真的收窄，模型不会按旧习惯传别的字段。
 */
export function summaryInputFor(format: SummaryFormat) {
  if (format === "markdown") return MarkdownSummaryInput
  if (format === "babel") return BabelSummaryInput
  return JsonSummaryInput
}
