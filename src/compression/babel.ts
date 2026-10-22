import type { BabelSummary } from "./schema.ts"

/** Babel 首行：`T=标题|G=目标`；允许两侧空格。 */
const HEADER_RE = /^\s*T\s*=\s*(.*?)\s*\|\s*G\s*=\s*(.*?)\s*$/i
/** 兼容模型把 T/G 写成两行的情况。 */
const TITLE_RE = /^\s*T\s*=\s*(.*?)\s*$/i
const GOAL_RE = /^\s*G\s*=\s*(.*?)\s*$/i
/** T2/T3 候选行：优先 `c=N`，兼容 `candidate: N`。 */
const CANDIDATE_RE = /^\s*(?:c|candidate)\s*[:=]\s*(\d+)\s*$/i

/** 输入：候选字符串；输出：第一个非空值，全部为空时返回空串。 */
function firstNonEmpty(...values: readonly (string | undefined)[]): string {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed !== undefined && trimmed.length > 0) return trimmed
  }
  return ""
}

/** 输入：模型原始文本；输出：去掉代码围栏和首尾空白的文本。 */
export function cleanBabel(text: string): string {
  return text
    .trim()
    .replace(/^```(?:babel|babeltele|text|md|markdown)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim()
}

/**
 * 输入：文本 + 可选显式 title/goal。
 * 输出：规范 Babel 摘要；缺少标题/目标/正文时返回 undefined。
 * 预期：首行优先解析 `T=...|G=...`，也接受两行 T/G；text 保留规范化首行。
 */
export function toBabelSummary(value: unknown, title?: string, goal?: string): BabelSummary | undefined {
  if (typeof value !== "string") return undefined
  const clean = cleanBabel(value)
  if (clean.length === 0) return undefined

  const lines = clean.split(/\r?\n/)
  const first = lines[0]?.trim() ?? ""
  const header = HEADER_RE.exec(first)
  let parsedTitle = header?.[1]?.trim()
  let parsedGoal = header?.[2]?.trim()
  let bodyLines = lines

  if (header !== null) {
    bodyLines = lines.slice(1)
  } else {
    const second = lines[1]?.trim() ?? ""
    const titleLine = TITLE_RE.exec(first)
    const goalLine = GOAL_RE.exec(second)
    if (titleLine !== null && goalLine !== null) {
      parsedTitle = titleLine[1]?.trim()
      parsedGoal = goalLine[1]?.trim()
      bodyLines = lines.slice(2)
    }
  }

  const resolvedTitle = firstNonEmpty(title, parsedTitle)
  const resolvedGoal = firstNonEmpty(goal, parsedGoal)
  if (resolvedTitle.length === 0 || resolvedGoal.length === 0) return undefined

  // 有首行时正文从首行之后开始；无首行但显式给了 title/goal 时保留整段正文。
  const body = bodyLines.join("\n").trim()
  if (body.length === 0) return undefined

  return {
    format: "babel",
    title: resolvedTitle,
    goal: resolvedGoal,
    text: `T=${resolvedTitle}|G=${resolvedGoal}\n${body}`,
  }
}

/** 输入：模型返回的文本；输出：首个非空行是否为 `c=N`，以及去掉该行后的正文。 */
export function splitBabelCandidate(text: string): { readonly candidate: number; readonly summary: string } | undefined {
  const clean = cleanBabel(text)
  const lines = clean.split(/\r?\n/)
  const first = lines[0]?.trim() ?? ""
  const match = CANDIDATE_RE.exec(first)
  if (match === null) return undefined
  const candidate = Number(match[1])
  if (!Number.isInteger(candidate)) return undefined
  return { candidate, summary: lines.slice(1).join("\n").trim() }
}
