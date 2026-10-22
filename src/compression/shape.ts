import type { SummaryFormat } from "../shared/settings.ts"

/**
 * 本模块只放「摘要长什么样」的文案。
 *
 * 压缩提示词（summarize.ts）和 compress 工具描述（tool.ts）都从这里取，
 * 避免两处各写一份、改一处忘另一处。
 */

const JSON_SHAPE = `{
  "title": "optional short label for this block",
  "goal": "required: the objective and any pivots it went through",
  "constraints": ["optional: hard limits and user preferences"],
  "decisions": ["optional: what was decided — why"],
  "progress": {
    "completed": ["optional: work actually finished"],
    "active": ["optional: work in progress, including what the user still expects"],
    "blocked": ["optional: what is blocked — why"]
  },
  "open_items": ["optional: unanswered questions, TODOs, next actions"],
  "files": ["optional: real file paths only, full/path.ext:line — role in the work"],
  "facts": ["optional: exact errors, signatures, versions, config keys, thresholds, measured values"]
}`

const MARKDOWN_SHAPE = `# Short title
## Goal
...
## Constraints
- ...
## Decisions
- ...
## Progress
### Completed
- ...
### Active
- ...
### Blocked
- ...
## Open Items
- ...
## Files
- ...
## Facts
- ...`

/** 输入：格式 + 是否要 candidate 行；输出：格式说明行。 */
export function shapeLines(format: SummaryFormat | undefined, withCandidate: boolean): string[] {
  if (format === "babel") {
    return [
      withCandidate
        ? "Return ONLY Babel text. First line must be `c=N`, where N is the chosen candidate; second line must be `T=<short title>|G=<one-line goal>`."
        : "Return ONLY Babel text. First line must be `T=<short title>|G=<one-line goal>`.",
      "After the header, use adaptive Babel: only T/G is fixed; invent the shortest anchors/delimiters for this source. No fixed key schema, no Markdown headings, no JSON, no code fences, no commentary.",
    ]
  }
  if (format === "markdown") {
    return [
      withCandidate
        ? "Return ONLY markdown. First line must be `candidate: N`, then a self-contained markdown checkpoint."
        : "Return ONLY markdown. Do not return JSON. Do not wrap in code fences.",
      MARKDOWN_SHAPE,
    ]
  }
  return [
    withCandidate
      ? "Return ONLY a JSON object with the normal summary shape PLUS a top-level `candidate` number:"
      : "Return ONLY a JSON object with this exact shape (no markdown fences, no commentary):",
    JSON_SHAPE,
  ]
}

/** 输入：摘要格式；输出：该格式的写法说明，供压缩提示词和工具描述共用。 */
export function summaryShape(format: SummaryFormat): string {
  return shapeLines(format, false).join("\n")
}
