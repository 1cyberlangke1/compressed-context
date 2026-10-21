import { Schema } from "effect"

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

/** 块摘要：JSON 保持原形状，Markdown 用 format 标记；旧 JSON 块天然兼容。 */
export type Summary = SummaryFields | MarkdownSummary

/** 输入：任意摘要；输出：是否 Markdown 摘要。 */
export function isMarkdownSummary(summary: Summary): summary is MarkdownSummary {
  return "format" in summary
}

/**
 * 模型侧摘要输入：JSON 字段都可选，Markdown 用 markdown 字段。
 *
 * 预期：JSON 模式在归一化时要求 goal；Markdown 模式要求 markdown。
 */
export const SummaryInput = Schema.Struct({
  format: Schema.optional(Schema.Union([Schema.Literal("json"), Schema.Literal("markdown")])),
  markdown: Schema.optional(Schema.String),
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
