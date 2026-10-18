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
  "goal": "one or two sentences",
  "constraints": ["..."],
  "decisions": ["decision — because ..."],
  "progress": {
    "completed": ["..."],
    "active": ["..."],
    "blocked": ["..."]
  },
  "open_items": ["..."],
  "files": ["path — why it matters"],
  "facts": ["exact errors, versions, config keys, signatures"]
}`

function buildPrompt(transcript: string): string {
  return [
    "You are writing a checkpoint that will replace an older part of a conversation.",
    "A later reader must be able to continue the work using only this checkpoint plus the messages that follow it.",
    "",
    "Return ONLY a JSON object with this exact shape (no markdown fences, no commentary):",
    SHAPE,
    "",
    "Rules:",
    "- Record the past as history. Never phrase recorded state as a live instruction.",
    "- Preserve exact file paths with line numbers, function/type signatures, error strings, commands, versions, and config keys.",
    "- Decisions must include the reason.",
    "- Keep unresolved user objectives and open questions.",
    "- Drop logs, duplicate reads, status checks, and dead ends (keep one line of the lesson).",
    "- Write in the source conversation's primary language.",
    "- Keep it compact. No preamble.",
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
