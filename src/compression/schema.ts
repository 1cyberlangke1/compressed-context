import { Schema } from "effect"

/**
 * 压缩块的结构化字段。
 *
 * 工具入参和侧调用 JSON 共用这一份 schema；
 * 所有字段必填，缺字段会在工具边界直接被拒。
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
