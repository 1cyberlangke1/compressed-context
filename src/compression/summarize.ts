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

/** ctx.session.generate 的最小结构：历史由 session 前缀提供，只追加 prompt。 */
export interface SessionGenerateLike {
  generate(input: { sessionID: string; prompt: string }): Promise<{ text: string }>
}

/** 输入：session 生成入口 + sessionID；输出：只追加指令、复用会话前缀的 GenerateLike。 */
export function sessionGenerator(session: SessionGenerateLike, sessionID: string): GenerateLike {
  return {
    text: async ({ prompt }) => {
      const response = await session.generate({ sessionID, prompt })
      return { text: response.text }
    },
  }
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

/** T1 的会话内指令：历史已经在 session 前缀里，只追加这段。 */
export function buildT1Instruction(): string {
  return [
    "You are writing a checkpoint for the older part of the conversation above.",
    "Summarize only the messages before the final user message; ignore the final user message and anything after it.",
    "The checkpoint replaces those older messages; make it self-contained.",
    "",
    "Return ONLY a JSON object with this exact shape (no markdown fences, no commentary):",
    SHAPE,
    "",
    rulesFor(1),
    "- Write in the source conversation's primary language.",
  ].join("\n")
}

/** T2/T3 的会话内指令：checkpoint 已经在 session 前缀里，只追加候选和规则。 */
export function buildMergeInstruction(candidates: readonly SummaryChoiceCandidate[]): string {
  const lines = candidates.map((candidate) => `${candidate.index.toString()}. ${candidate.description}`)
  return [
    "The checkpoint at the top of the conversation contains summary blocks.",
    "Merge ONLY the chosen pair from the candidate list below; ignore every message after the checkpoint.",
    "The messages after the checkpoint describe the current task; use them only to judge what is least needed, never include them in the merged summary.",
    "",
    "Return ONLY a JSON object with the normal summary shape PLUS a top-level `candidate` number:",
    SHAPE,
    "",
    CHOICE_RULES,
    "",
    "Candidates (oldest first):",
    ...lines,
  ].join("\n")
}

/** 多候选合并时，模型要额外返回的候选信息。 */
export interface SummaryChoiceCandidate {
  /** 1 开始的选择编号。 */
  readonly index: number
  /** 候选描述，例如 `b1 T2 "title" — goal + b2 ... → T3`。 */
  readonly description: string
  /** 这对块的完整 transcript 字符数，用于校验摘要确实更小。 */
  readonly sourceChars: number
  readonly tier: Tier
}

const CHOICE_RULES = `Guidance for choosing and merging:
- Exactly one adjacent pair may be merged. Pick one candidate from the list below and merge ONLY that pair; every other block is context for the decision, not part of the merge.
- Add a top-level "candidate": N field to the JSON object, where N is the chosen candidate number. The rest of the object must follow the exact shape above.
- Keep the latest objective and hard constraints, decisions with their reasons, final outcomes, open items and blocked work, and exact facts that still matter.
- Merge duplicate facts across the chosen pair, keep the latest status, and drop process, logs, repeated reads, full diffs, and non-load-bearing line numbers.
- If the chosen candidate's output tier is 2, target roughly 50-150 tokens per source block. If it is tier 3, be ultra-condensed: one to three single-line facts per source block.
- Do not invent facts. Write in the source conversation's primary language.`

function buildChoicePrompt(
  context: string,
  task: string,
  candidates: readonly SummaryChoiceCandidate[],
): string {
  const lines = candidates.map((candidate) => `${candidate.index.toString()}. ${candidate.description}`)
  return [
    "You are merging existing checkpoint blocks into one denser checkpoint.",
    "The checkpoint chain is over its token budget. The algorithm has listed every legal adjacent merge below.",
    "",
    "Return ONLY a JSON object with the normal summary shape PLUS a top-level `candidate` number:",
    SHAPE,
    "",
    CHOICE_RULES,
    "",
    "Current task:",
    task,
    "",
    "Candidates (oldest first):",
    ...lines,
    "",
    "Sources (the whole active chain; use it to judge the task, but merge only the chosen pair):",
    context,
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

async function runSummaryPrompt(
  base: string,
  sourceChars: number,
  generate: GenerateLike,
  model: ModelRefLike | undefined,
): Promise<Summary | undefined> {
  let prompt = base
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let text: string
    try {
      const response = await generate.text(model ? { prompt, model } : { prompt })
      text = response.text
    } catch {
      return undefined
    }

    const decoded = decode(parseJsonSafe(text))
    if (decoded) {
      const result = validateSummary(decoded, sourceChars)
      if (result.ok) return decoded
      prompt = `${base}\n\nYour previous reply was rejected: ${result.message}. Return the corrected JSON only.`
      continue
    }
    prompt = `${base}\n\nYour previous reply was not valid JSON matching the shape. Return the corrected JSON only.`
  }
  return undefined
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
  return runSummaryPrompt(buildPrompt(input.transcript, tier), input.sourceChars, input.generate, input.model)
}

/** 输入：已经拼好的会话内指令；输出：摘要；失败返回 undefined。 */
export async function summarizeInstruction(input: {
  readonly prompt: string
  readonly sourceChars: number
  readonly generate: GenerateLike
  readonly model?: ModelRefLike
}): Promise<Summary | undefined> {
  return runSummaryPrompt(input.prompt, input.sourceChars, input.generate, input.model)
}

/** 输入：解析后的 JSON；输出：去掉 candidate 后的摘要值 + 原始 candidate。 */
function splitCandidate(value: unknown): { readonly candidate: unknown; readonly summary: unknown } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const summary: Record<string, unknown> = { ...(value as Record<string, unknown>) }
  const candidate = summary["candidate"]
  delete summary["candidate"]
  return { candidate, summary }
}

async function runChoicePrompt(
  base: string,
  candidates: readonly SummaryChoiceCandidate[],
  generate: GenerateLike,
  model: ModelRefLike | undefined,
): Promise<{ readonly summary: Summary; readonly candidate: SummaryChoiceCandidate } | undefined> {
  let prompt = base
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let text: string
    try {
      const response = await generate.text(model ? { prompt, model } : { prompt })
      text = response.text
    } catch {
      return undefined
    }

    const split = splitCandidate(parseJsonSafe(text))
    if (split !== undefined && typeof split.candidate === "number" && Number.isInteger(split.candidate)) {
      const candidate = candidates[split.candidate - 1]
      if (candidate !== undefined) {
        const decoded = decode(split.summary)
        if (decoded) {
          const result = validateSummary(decoded, candidate.sourceChars)
          if (result.ok) return { summary: decoded, candidate }
          prompt = `${base}\n\nYour previous reply was rejected: ${result.message}. Return the corrected JSON only.`
          continue
        }
      }
    }
    prompt = `${base}\n\nYour previous reply was not valid JSON with a valid candidate and summary. Return the corrected JSON only.`
  }
  return undefined
}

/**
 * 输入：整条 active 链、当前任务、合法候选、generate、模型。
 * 输出：模型选择的候选 + 同一次回复里的摘要；失败返回 undefined。
 * 预期：一次调用同时完成“选哪对”和“写合并摘要”，多一个 candidate 字段。
 */
export async function summarizeWithChoice(input: {
  readonly context: string
  readonly task: string
  readonly candidates: readonly SummaryChoiceCandidate[]
  readonly generate: GenerateLike
  readonly model?: ModelRefLike
}): Promise<{ readonly summary: Summary; readonly candidate: SummaryChoiceCandidate } | undefined> {
  return runChoicePrompt(
    buildChoicePrompt(input.context, input.task, input.candidates),
    input.candidates,
    input.generate,
    input.model,
  )
}

/** 输入：已经拼好的合并指令 + 候选；输出：选择 + 摘要；失败返回 undefined。 */
export async function summarizeChoiceInstruction(input: {
  readonly prompt: string
  readonly candidates: readonly SummaryChoiceCandidate[]
  readonly generate: GenerateLike
  readonly model?: ModelRefLike
}): Promise<{ readonly summary: Summary; readonly candidate: SummaryChoiceCandidate } | undefined> {
  return runChoicePrompt(input.prompt, input.candidates, input.generate, input.model)
}
