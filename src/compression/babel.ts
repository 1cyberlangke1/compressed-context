import { diagnostic, type Diagnostic } from "../shared/diagnostic.ts"
import type { BabelSummary } from "./schema.ts"

/** Babel 首行：`T=标题|G=目标`；允许两侧空格。 */
const HEADER_RE = /^\s*T\s*=\s*(.*?)\s*\|\s*G\s*=\s*(.*?)\s*$/i
/** 兼容模型把 T/G 写成两行的情况。 */
const TITLE_RE = /^\s*T\s*=\s*(.*?)\s*$/i
const GOAL_RE = /^\s*G\s*=\s*(.*?)\s*$/i

/** 首行形状诊断的字段；由 explainBabelShape 产出，供工具层渲染编译器式错误。 */
export interface BabelShapeIssue {
  readonly at: string
  readonly expected: string
  readonly got: string
  readonly excerpt: string
  readonly fix: string
}

/**
 * 输入：清洗后的 Babel 文本。
 * 输出：解析失败时的精确诊断字段；能解析或不是形状问题时返回 undefined。
 * 预期：与 toBabelSummary 共用同一套正则，指出首行缺 `|G=`、缺正文、或首行不是 `T=...|G=...`。
 */
export function explainBabelShape(clean: string): BabelShapeIssue | undefined {
  const lines = clean.split(/\r?\n/)
  const first = lines[0]?.trim() ?? ""
  const second = lines[1]?.trim() ?? ""
  const header = HEADER_RE.exec(first)
  const titleOnly = TITLE_RE.exec(first)
  const goalOnly = GOAL_RE.exec(first)
  const secondIsGoal = GOAL_RE.exec(second) !== null

  // 合法首行 `T=..|G=..`：只有当没有正文时才报错。
  if (header !== null) {
    const body = lines.slice(1).join("\n").trim()
    if (body.length === 0) {
      return {
        at: "babel[2:1]",
        expected: "a non-empty symbolic body after line 1",
        got: "<empty>",
        excerpt: first,
        fix: "add symbolic index lines (S[], F[path:line], D[], Config[k=v]) after the header",
      }
    }
    return undefined
  }

  // 两行写法 `T=..\nG=..`：首行是 T=，第二行是 G=，合法；只看有没有正文。
  if (titleOnly !== null && secondIsGoal) {
    const body = lines.slice(2).join("\n").trim()
    if (body.length === 0) {
      return {
        at: "babel[3:1]",
        expected: "a non-empty symbolic body after the T/G lines",
        got: "<empty>",
        excerpt: `${first}\n${second}`,
        fix: "add symbolic index lines (S[], F[path:line], D[], Config[k=v]) below the T/G lines",
      }
    }
    return undefined
  }

  // 多行但首行是纯 `T=标题`、第二行不是 G=：两行写法缺 G=。
  if (titleOnly !== null && lines.length > 1) {
    return {
      at: "babel[2:1]",
      expected: "G=<goal> on line 2 (or '|G=' on line 1)",
      got: second.length > 0 ? second : "<empty>",
      excerpt: `${first}\n${second}`,
      fix: `put 'G=<goal>' on line 2, or use the single-line form ${first}|G=<goal>`,
    }
  }

  // 单行 `T=标题`：缺 `|G=`。
  if (titleOnly !== null) {
    return {
      at: "babel[1:1..1:first-line-end]",
      expected: "T=<title>|G=<goal> on line 1",
      got: first,
      excerpt: first,
      fix: `append '|G=<goal>' to line 1, e.g. ${first}|G=<goal>`,
    }
  }
  // 单行 `G=目标`：缺 `T=`。
  if (goalOnly !== null) {
    return {
      at: "babel[1:1..1:first-line-end]",
      expected: "T=<title>|G=<goal> on line 1",
      got: first,
      excerpt: first,
      fix: `prepend 'T=<title>|' to line 1, e.g. T=<title>|${first}`,
    }
  }
  // 首行完全不是 T=... 形状。
  return {
    at: "babel[1:1]",
    expected: "line 1 = T=<title>|G=<goal>",
    got: first.length > 0 ? first : "<empty>",
    excerpt: first,
    fix: "start line 1 with 'T=<title>|G=<goal>', then put the symbolic body below it",
  }
}

/**
 * 输入：Babel 文本（或含 babel/text/summary 字段的对象）+ 可选显式 title/goal。
 * 输出：解析失败时的编译器式诊断；能解析时返回 undefined。
 * 预期：工具层在 toSummary 返回 undefined 时据此给出 expected/got/excerpt，而不是笼统的 invalid shape。
 */
export function babelShapeDiagnostic(value: unknown, format: string): Diagnostic | undefined {
  let text: string | undefined
  if (typeof value === "string") text = value
  else if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>
    for (const key of ["babel", "markdown", "text", "summary", "content"]) {
      const candidate = record[key]
      if (typeof candidate === "string") {
        text = candidate
        break
      }
    }
  }
  if (text === undefined) {
    return diagnostic({
      tool: "compress",
      code: "SUMMARY_SHAPE",
      summary: `no ${format} text found in tool arguments`,
      at: `input.${format}`,
      expected: `a '${format}' string`,
      got: JSON.stringify(value).slice(0, 120),
      fix: `pass the summary as a '${format}' string, e.g. { "${format}": "..." }`,
    })
  }
  const issue = explainBabelShape(cleanBabel(text))
  if (issue === undefined) return undefined
  return diagnostic({
    tool: "compress",
    code: "BABEL_HEADER",
    summary: `the ${format} summary header/body is malformed`,
    at: issue.at,
    expected: issue.expected,
    got: issue.got,
    excerpt: issue.excerpt,
    fix: issue.fix,
  })
}
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
