import { Schema } from "effect"
import { jsonrepair } from "jsonrepair"

import { SummaryFields, type SummaryFields as Summary } from "./schema.ts"
import type { Tier } from "./state.ts"
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

const TIER2_RULES = `Guidance for merging existing checkpoints:
- The sources are already compressed summaries, not raw conversation. Merge them into one checkpoint that covers all of them; do not re-tell the process.
- Keep only what future work needs: the latest objective and hard constraints; decisions with their reasons; final outcomes; open items and blocked work; the user's still-open expectations.
- Keep exact paths, signatures, errors, versions, config keys, and measured values only when they still matter. Drop line numbers, full diffs, code listings, logs, repeated reads, and intermediate debugging.
- Merge duplicate facts across sources and keep the latest status. Mark superseded or obsolete content with one short marker; do not keep its details.
- A failed attempt may stay as one line saying what failed and why, because that prevents repeating it.
- Target roughly 50-150 tokens per source block. Prefer dense factual entries over narrative.`

const TIER3_RULES = `Guidance for ultra-condensing existing checkpoints:
- Reduce the sources to a lookup index. Keep only shipped outcomes, open work, architectural decisions, and critical constraints.
- For each source block, keep one to three single-line facts: subject plus outcome.
- Drop explanations, rationale details, process, logs, and anything already marked obsolete or superseded.
- Open user-requested objectives survive until a later source marks them completed or superseded.
- Target roughly 30-60 tokens per source block.`

function rulesFor(tier: Tier): string {
  if (tier === 2) return TIER2_RULES
  if (tier === 3) return TIER3_RULES
  return TIER1_RULES
}

function openingFor(tier: Tier): string {
  if (tier === 1) {
    return "You are writing a checkpoint that will replace an older part of a conversation."
  }
  return "You are merging existing checkpoint blocks into one denser checkpoint."
}

function buildPrompt(transcript: string, tier: Tier): string {
  return [
    openingFor(tier),
    "The checkpoint and the messages after it are all the next reader will see; make it self-contained.",
    "",
    "Return ONLY a JSON object with this exact shape (no markdown fences, no commentary):",
    SHAPE,
    "",
    rulesFor(tier),
    "- Write in the source conversation's primary language.",
    "",
    "Sources:",
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

function parseJsonSafe(text: string): unknown {
  try {
    return parseJson(text)
  } catch {
    return undefined
  }
}

function decode(value: unknown): Summary | undefined {
  try {
    return Schema.decodeUnknownSync(SummaryFields)(value)
  } catch {
    return undefined
  }
}

/**
 * 输入：transcript、原文长度、generate、模型、目标层级。
 * 输出：校验通过的摘要；失败返回 undefined。
 * 预期：JSON 修复 + schema 解码 + 语义校验；失败重试一次。
 */
export async function summarize(input: {
  readonly transcript: string
  readonly sourceChars: number
  readonly generate: GenerateLike
  readonly model?: ModelRefLike
  readonly tier?: Tier
}): Promise<Summary | undefined> {
  const tier = input.tier ?? 1
  const base = buildPrompt(input.transcript, tier)
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
