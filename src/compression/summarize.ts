import { Schema } from "effect"
import { jsonrepair } from "jsonrepair"

import { SummaryFields, type SummaryFields as Summary } from "./schema.ts"
import { validateSummary } from "./validate.ts"

/** 模型引用的最小结构。 */
export interface ModelRefLike {
  readonly providerID: string
  readonly id: string
  readonly variant?: string | undefined
}

/** ctx.generate 的最小结构，便于测试替身。 */
export interface GenerateLike {
  text(input: { prompt: string; model?: ModelRefLike }): Promise<{ text: string }>
}

const SHAPE = `{
  "title": "short label for this block",
  "goal": "the objective and any pivots it went through",
  "constraints": ["hard limits and user preferences"],
  "decisions": ["what was decided — why"],
  "progress": {
    "completed": ["finished work"],
    "active": ["work in progress, including what the user still expects"],
    "blocked": ["what is blocked — why"]
  },
  "open_items": ["unanswered questions, TODOs, next actions"],
  "files": ["full/path.ext:line — role in the work"],
  "facts": ["exact errors, signatures, versions, config keys, thresholds, measured values"]
}`

const TIER1_RULES = `Guidance:
- This checkpoint replaces the messages above; the next reader sees it instead of them, so it must stand on its own.
- Describe what already happened as history. Do not turn a recorded plan or request into an instruction to act now.
- Copy exact identifiers instead of describing them: full paths with line numbers, function and type signatures, the line of code that carries the logic, error text, versions, config keys, thresholds, and measured numbers.
- For each decision, say why it was made. Keep discovered constraints, the user's objective and any change of direction, the reason behind important actions, unanswered questions, and work the user still expects.
- Quote the user only when the exact wording matters; otherwise paraphrase and never invent a quote.
- Omit build/test logs, repeated reads, exploration that produced nothing, abandoned attempts (keep one line on why they failed), repeated status checks, and discussion that has already reached a conclusion.
- If space is tight, keep in this order: objective and constraints; decisions and reasons; exact technical facts; conclusions; lessons from failures.
- Prefer short factual entries over prose. Group related entries under the field that fits them.`

function buildPrompt(transcript: string): string {
  return [
    "You are writing a checkpoint that will replace an older part of a conversation.",
    "The checkpoint and the messages after it are all the next reader will see; make it self-contained.",
    "",
    "Return ONLY a JSON object with this exact shape (no markdown fences, no commentary):",
    SHAPE,
    "",
    TIER1_RULES,
    "- Write in the source conversation's primary language.",
    "",
    "Conversation:",
    transcript,
  ].join("\n")
}

function parseJson(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
  return JSON.parse(jsonrepair(cleaned))
}

function decode(value: unknown): Summary | undefined {
  try {
    return Schema.decodeUnknownSync(SummaryFields)(value)
  } catch {
    return undefined
  }
}

/**
 * 输入：transcript、原文长度、generate、模型。
 * 输出：校验通过的摘要；失败返回 undefined。
 * 预期：JSON 修复 + schema 解码 + 语义校验；失败重试一次。
 */
export async function summarize(input: {
  readonly transcript: string
  readonly sourceChars: number
  readonly generate: GenerateLike
  readonly model?: ModelRefLike
}): Promise<Summary | undefined> {
  const base = buildPrompt(input.transcript)
  let prompt = base
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let text: string
    try {
      const response = await input.generate.text(input.model ? { prompt, model: input.model } : { prompt })
      text = response.text
    } catch {
      return undefined
    }

    const decoded = decode(parseJsonSafe(text))
    if (decoded) {
      const result = validateSummary(decoded, input.sourceChars)
      if (result.ok) return decoded
      prompt = `${base}\n\nYour previous reply was rejected: ${result.message}. Return the corrected JSON only.`
      continue
    }
    prompt = `${base}\n\nYour previous reply was not valid JSON matching the shape. Return the corrected JSON only.`
  }
  return undefined
}

function parseJsonSafe(text: string): unknown {
  try {
    return parseJson(text)
  } catch {
    return undefined
  }
}
