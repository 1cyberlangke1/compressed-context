import { jsonrepair } from "jsonrepair"

import type { SummaryFormat, SummaryLanguage } from "../shared/settings.ts"
import { splitBabelCandidate, toBabelSummary } from "./babel.ts"
import { toSummary } from "./normalize.ts"
import type { Summary } from "./schema.ts"
import { shapeLines } from "./shape.ts"
import type { Tier } from "./state.ts"
import { MAX_SUMMARY_CHARS, MIN_SUMMARY_CHARS, minSummaryChars, validateSummary } from "./validate.ts"

/** 摘要/合并调用遇到坏格式时的尝试次数；真实模型偶尔会漏 candidate 或 goal。 */
const SUMMARY_ATTEMPTS = 3

/** 摘要提示词的可调部分；只改尾部指令，不改会话前缀。 */
export interface SummaryPromptOptions {
  readonly maxChars?: number
  readonly totalChars?: number
  readonly language?: SummaryLanguage
  readonly format?: SummaryFormat
}

/** 输入：摘要语言；输出：只用于提示词的语言约束。 */
function languageLine(language: SummaryLanguage | undefined): string {
  if (language === "zh") return "Write the summary in Chinese."
  if (language === "en") return "Write the summary in English."
  return "Write in the source conversation's primary language."
}

/** 输入：选项；输出：长度、语言和格式规则提示行。 */
function promptRules(options: SummaryPromptOptions | undefined): string[] {
  const maxChars = options?.maxChars ?? MAX_SUMMARY_CHARS
  const lines =
    options?.format === "babel"
      ? [
          "- Audience=peer LLM. Notation only, not content: drop grammar/connectives, mix languages/emoji/math（forall、exists、in、=>）.",
          "- Only `T=<short title>|G=<one-line goal>` fixed; invent anchors and reuse them; no headings/paragraphs/sentences/JSON/fences.",
          "- Anchors: `S[module]` `D[decision]:why` `F[path:line]` `C[step>step]` `Config[target]:k=v` `?cond=>action` `!edge:detail` `Eval[A/B]:result`; flatten parallel items `[A,B,C]`.",
          "- Files `F:[...]` complete, never \"various files\"; commands `C:[...]` verbatim, never paraphrase.",
          "- Lossless: entity graph, exact numbers (no rounding), versions, config keys, thresholds, formulas, conditions, causality, exceptions, comparisons, placeholders, paths, signatures, error text; unknown=?/NULL, never invent.",
          `- Keep this summary under ${maxChars.toString()} characters.`,
        ]
      : options?.format === "markdown"
        ? [
            "- Return ONLY markdown, no JSON, no code fences.",
            "- Start with a short `# Title` line.",
            "- Only include sections with real content; never invent entries to fill a section.",
            "- Use real file paths in `## Files`; put config keys and function names in `## Facts`.",
            "- Put work in `### Completed` only when it was actually finished; plans go in `### Active` or `## Open Items`.",
            `- Keep this summary under ${maxChars.toString()} characters.`,
          ]
        : [
            "- Only \"goal\" is required. Omit any optional field that has no real content; never invent entries to fill it.",
            "- Use \"files\" only for real file paths; put config keys and function names in \"facts\".",
            "- Put work in \"progress.completed\" only when the source shows it was finished; plans go in \"progress.active\" or \"open_items\".",
            `- Keep this summary under ${maxChars.toString()} characters.`,
          ]
  if (options?.totalChars !== undefined) {
    lines.push(`- The whole active checkpoint chain must stay under ${options.totalChars.toString()} characters.`)
  }
  // Babel 的卖点就是跨语言/符号密度，不能再强制单一语言。
  if (options?.format !== "babel") lines.push(`- ${languageLine(options?.language)}`)
  return lines
}

/** 输入：摘要格式；输出：提示词和错误里的格式名。 */
function formatName(format: SummaryFormat): string {
  if (format === "babel") return "Babel"
  if (format === "markdown") return "Markdown"
  return "JSON"
}

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
      if (typeof response.text !== "string") {
        throw new Error("session.generate returned no text")
      }
      return { text: response.text }
    },
  }
}

const BABEL_T1_RULES = `Guidance:
- This checkpoint replaces the messages above; the next reader sees it instead of them, so it must stand on its own. Describe what already happened as history, not as instructions to act now.
- Keep the objective and hard constraints, decisions with their reasons, outcomes, open items, work the user still expects, and failure lessons.
- Coverage: every topic, file path, test count, command, and version in the source must appear; never omit one because another seems more important.
- Copy exact identifiers instead of describing them: full paths with line numbers, the line of code that carries the logic, signatures, error text, versions, config keys, thresholds, measured values.
- Omit build/test logs, repeated reads, exploration that produced nothing, abandoned attempts (one line on why they failed), repeated status checks, and settled discussion.
- If space is tight, keep in this order: objective and constraints; decisions and reasons; exact technical facts; conclusions; lessons from failures.`

const BABEL_T2_RULES = `Guidance for merging existing checkpoints:
- The sources are already compressed; merge them into one checkpoint covering all of them, without re-telling the process.
- Keep the latest objective and hard constraints, decisions with their reasons, final outcomes, open items, blocked work, and the user's still-open expectations.
- Merge duplicate facts and keep the latest status; mark superseded content with one short marker and drop its details.
- Drop process, logs, full diffs, code listings, and non-load-bearing line numbers. A failed attempt may stay as one line on why it failed.
- Target roughly 50-150 tokens per source block.`

const BABEL_T3_RULES = `Guidance for ultra-condensing existing checkpoints:
- Reduce the sources to a lookup index: one to three single-line facts per source block, subject plus outcome.
- Keep only shipped outcomes, open work, architectural decisions, and critical constraints.
- Drop explanations, rationale details, process, logs, and anything already obsolete or superseded.
- Open user-requested objectives survive until a later source marks them completed or superseded.
- Target roughly 30-60 tokens per source block.`

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

function rulesFor(tier: Tier, format?: SummaryFormat): string {
  if (format === "babel") return tier === 1 ? BABEL_T1_RULES : tier === 2 ? BABEL_T2_RULES : BABEL_T3_RULES
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

function buildPrompt(transcript: string, tier: Tier, options?: SummaryPromptOptions): string {
  return [
    openingFor(tier),
    "The checkpoint and the messages after it are all the next reader will see; make it self-contained.",
    "",
    ...shapeLines(options?.format, false),
    "",
    rulesFor(tier, options?.format),
    ...promptRules(options),
    "",
    "Sources:",
    transcript,
  ].join("\n")
}

/** T1 的会话内指令：历史已经在 session 前缀里，只追加这段。 */
export function buildT1Instruction(options?: SummaryPromptOptions): string {
  return [
    "You are writing a checkpoint for the older part of the conversation above.",
    "Summarize only the messages before the final user message; ignore the final user message and anything after it.",
    "The checkpoint replaces those older messages; make it self-contained.",
    "",
    ...shapeLines(options?.format, false),
    "",
    rulesFor(1, options?.format),
    ...promptRules(options),
  ].join("\n")
}

/** T2/T3 的会话内指令：checkpoint 已经在 session 前缀里，只追加候选和规则。 */
export function buildMergeInstruction(
  candidates: readonly SummaryChoiceCandidate[],
  options?: SummaryPromptOptions,
): string {
  const lines = candidates.map((candidate) => `${candidate.index.toString()}. ${candidate.description}`)
  return [
    "The checkpoint at the top of the conversation contains summary blocks.",
    "Merge ONLY the chosen pair from the candidate list below; ignore every message after the checkpoint.",
    "The messages after the checkpoint describe the current task; use them only to judge what is least needed, never include them in the merged summary.",
    "",
    ...shapeLines(options?.format, true),
    "",
    options?.format === "babel"
      ? BABEL_CHOICE_RULES
      : options?.format === "markdown"
        ? MARKDOWN_CHOICE_RULES
        : CHOICE_RULES,
    ...promptRules(options),
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

const MARKDOWN_CHOICE_RULES = `Guidance for choosing and merging:
- Exactly one adjacent pair may be merged. Pick one candidate from the list below and merge ONLY that pair; every other block is context for the decision, not part of the merge.
- First line must be \`candidate: N\`, where N is the chosen candidate number.
- After that line, write a self-contained markdown checkpoint starting with a short \`# Title\`.
- Keep the latest objective and hard constraints, decisions with their reasons, final outcomes, open items and blocked work, and exact facts that still matter.
- Merge duplicate facts across the chosen pair, keep the latest status, and drop process, logs, repeated reads, full diffs, and non-load-bearing line numbers.
- If the chosen candidate's output tier is 2, target roughly 50-150 tokens per source block. If it is tier 3, be ultra-condensed: one to three single-line facts per source block.
- Do not invent facts. Write in the source conversation's primary language.`

const BABEL_CHOICE_RULES = `Guidance for choosing and merging:
- Exactly one adjacent pair may be merged. Pick one candidate from the list below and merge ONLY that pair; every other block is context for the decision, not part of the merge.
- First line must be \`c=N\`, where N is the chosen candidate number. Second line must be \`T=<short title>|G=<one-line goal>\`; after that write adaptive Babel with anchors you invent and reuse.
- Babel changes only notation, not content: same policy as a normal merge checkpoint. No Markdown headings, no JSON, no prose/sentences, no code fences.
- Keep the latest objective and hard constraints, decisions with their reasons, final outcomes, open items, blocked work, and exact facts that still matter.
- Merge duplicate facts across the chosen pair, keep the latest status, and drop process, logs, repeated reads, full diffs, and non-load-bearing line numbers.
- If the chosen candidate's output tier is 2, target roughly 50-150 tokens per source block. If it is tier 3, be ultra-condensed: one to three single-line facts per source block.
- Do not invent facts.`

function buildChoicePrompt(
  context: string,
  task: string,
  candidates: readonly SummaryChoiceCandidate[],
  options?: SummaryPromptOptions,
): string {
  const lines = candidates.map((candidate) => `${candidate.index.toString()}. ${candidate.description}`)
  return [
    "You are merging existing checkpoint blocks into one denser checkpoint.",
    "The checkpoint chain is over its token budget. The algorithm has listed every legal adjacent merge below.",
    "",
    ...shapeLines(options?.format, true),
    "",
    options?.format === "babel"
      ? BABEL_CHOICE_RULES
      : options?.format === "markdown"
        ? MARKDOWN_CHOICE_RULES
        : CHOICE_RULES,
    ...promptRules(options),
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
  // 真实模型常会在 JSON 前后加一句说明；只取第一个对象范围再修复。
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  const candidate = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned
  const parsed: unknown = JSON.parse(jsonrepair(candidate))
  // 有些模型会把 JSON 再编码成字符串；解一层。
  return typeof parsed === "string" ? JSON.parse(jsonrepair(parsed)) : parsed
}

function parseJsonSafe(text: string): unknown {
  try {
    return parseJson(text)
  } catch {
    return undefined
  }
}

/**
 * 输入：模型返回的 Markdown 文本。
 * 输出：优先按 JSON 解析，失败再按 Markdown 原文解析。
 * 预期：模型无视格式要求直接回 JSON 时，不把原始 JSON 当成摘要正文。
 */
function decodeMarkdownSummary(text: string): Summary | undefined {
  const parsed = parseJsonSafe(text)
  if (parsed !== undefined) {
    const fromJson = toSummary(parsed, "markdown")
    if (fromJson !== undefined) return fromJson
  }
  return toSummary(text, "markdown")
}

async function runSummaryPrompt(
  base: string,
  sourceChars: number,
  generate: GenerateLike,
  model: ModelRefLike | undefined,
  maxChars: number | undefined,
  format: SummaryFormat,
  onFailure?: (reason: string) => void,
): Promise<Summary | undefined> {
  let prompt = base
  let reason = "summary rejected"
  for (let attempt = 0; attempt < SUMMARY_ATTEMPTS; attempt += 1) {
    let text: string
    try {
      const response = await generate.text(model ? { prompt, model } : { prompt })
      text = response.text
    } catch (error) {
      onFailure?.(`generate failed: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }

    const decoded =
      format === "babel"
        ? toBabelSummary(text)
        : format === "markdown"
          ? decodeMarkdownSummary(text)
          : toSummary(parseJsonSafe(text), "json")
    if (decoded) {
      const result = validateSummary(decoded, sourceChars, MIN_SUMMARY_CHARS, maxChars)
      if (result.ok) return decoded
      reason = result.message
      prompt = `${base}\n\nYour previous reply was rejected: ${result.message}. Return the corrected ${formatName(format)} only.`
      continue
    }
    reason =
      format === "babel"
        ? "reply was not valid Babel with a T/G header"
        : format === "markdown"
          ? "reply was not valid markdown"
          : "reply was not valid JSON matching the shape"
    prompt = `${base}\n\nYour previous reply was not valid ${formatName(format)}. Return the corrected ${formatName(format)} only.`
  }
  onFailure?.(reason)
  throw new Error(reason)
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
  readonly maxChars?: number
  readonly totalChars?: number
  readonly language?: SummaryLanguage
  readonly format?: SummaryFormat
}): Promise<Summary | undefined> {
  const tier = input.tier ?? 1
  const format = input.format ?? "json"
  return runSummaryPrompt(
    buildPrompt(input.transcript, tier, input),
    input.sourceChars,
    input.generate,
    input.model,
    input.maxChars,
    format,
  )
}

/** 输入：已经拼好的会话内指令；输出：摘要；失败返回 undefined。 */
export async function summarizeInstruction(input: {
  readonly prompt: string
  readonly sourceChars: number
  readonly generate: GenerateLike
  readonly model?: ModelRefLike
  readonly maxChars?: number
  readonly format?: SummaryFormat
  readonly onFailure?: (reason: string) => void
}): Promise<Summary | undefined> {
  return runSummaryPrompt(
    input.prompt,
    input.sourceChars,
    input.generate,
    input.model,
    input.maxChars,
    input.format ?? "json",
    input.onFailure,
  )
}

/** 输入：解析后的 JSON；输出：去掉 candidate 后的摘要值 + 原始 candidate。 */
function splitCandidate(value: unknown): { readonly candidate: unknown; readonly summary: unknown } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const summary: Record<string, unknown> = { ...(value as Record<string, unknown>) }
  const candidate = summary["candidate"]
  delete summary["candidate"]
  return { candidate, summary }
}

/**
 * 输入：Markdown 回复；输出：candidate + 剩余正文。
 * 预期：接受 `candidate: N`（可带标题/加粗/中文冒号），也接受模型直接返回 JSON；
 *       两种形状都解析失败才返回 undefined。
 */
function splitMarkdownCandidate(text: string): { readonly candidate: unknown; readonly summary: unknown } | undefined {
  const match = /^\s*(?:#{1,6}\s*)?(?:\*\*)?candidate(?:\*\*)?\s*[:：]\s*(\d+)\s*$/im.exec(text)
  if (match !== null) {
    return { candidate: Number(match[1]), summary: text.replace(match[0], "").trim() }
  }
  return splitCandidate(parseJsonSafe(text))
}

async function runChoicePrompt(
  base: string,
  candidates: readonly SummaryChoiceCandidate[],
  generate: GenerateLike,
  model: ModelRefLike | undefined,
  maxChars: number | undefined,
  format: SummaryFormat,
  onFailure?: (reason: string) => void,
): Promise<{ readonly summary: Summary; readonly candidate: SummaryChoiceCandidate } | undefined> {
  let prompt = base
  let reason = "choice rejected"
  for (let attempt = 0; attempt < SUMMARY_ATTEMPTS; attempt += 1) {
    let text: string
    try {
      const response = await generate.text(model ? { prompt, model } : { prompt })
      text = response.text
    } catch (error) {
      onFailure?.(`generate failed: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }

    const split =
      format === "babel"
        ? splitBabelCandidate(text)
        : format === "markdown"
          ? splitMarkdownCandidate(text)
          : splitCandidate(parseJsonSafe(text))
    if (split !== undefined && typeof split.candidate === "number" && Number.isInteger(split.candidate)) {
      const candidate = candidates[split.candidate - 1]
      if (candidate !== undefined) {
        const decoded = toSummary(split.summary, format)
        if (decoded) {
          const result = validateSummary(
            decoded,
            candidate.sourceChars,
            minSummaryChars(candidate.tier),
            maxChars,
          )
          if (result.ok) return { summary: decoded, candidate }
          reason = result.message
          prompt = `${base}\n\nYour previous reply was rejected: ${result.message}. Return the corrected ${formatName(format)} only.`
          continue
        }
      }
    }
    reason =
      format === "babel"
        ? "reply was not valid Babel with a valid candidate"
        : format === "markdown"
          ? "reply was not valid markdown with a valid candidate"
          : "reply was not valid JSON with a valid candidate and summary"
    prompt =
      format === "babel"
        ? `${base}\n\nYour previous reply was not valid Babel. Return the corrected Babel only. First line must be \`c=N\` with N from 1 to ${candidates.length.toString()}; second line must be \`T=<title>|G=<goal>\`.`
        : format === "markdown"
          ? `${base}\n\nYour previous reply was not valid markdown. Return the corrected markdown only. First line must be \`candidate: N\` with N from 1 to ${candidates.length.toString()}.`
          : `${base}\n\nYour previous reply was not valid JSON with a valid candidate and summary. Return the corrected JSON only. The top-level "candidate" must be an integer from 1 to ${candidates.length.toString()}; "goal" must be non-empty.`
  }
  onFailure?.(reason)
  throw new Error(reason)
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
  readonly maxChars?: number
  readonly totalChars?: number
  readonly language?: SummaryLanguage
  readonly format?: SummaryFormat
  readonly onFailure?: (reason: string) => void
}): Promise<{ readonly summary: Summary; readonly candidate: SummaryChoiceCandidate } | undefined> {
  return runChoicePrompt(
    buildChoicePrompt(input.context, input.task, input.candidates, input),
    input.candidates,
    input.generate,
    input.model,
    input.maxChars,
    input.format ?? "json",
    input.onFailure,
  )
}

/** 输入：已经拼好的合并指令 + 候选；输出：选择 + 摘要；失败返回 undefined。 */
export async function summarizeChoiceInstruction(input: {
  readonly prompt: string
  readonly candidates: readonly SummaryChoiceCandidate[]
  readonly generate: GenerateLike
  readonly model?: ModelRefLike
  readonly maxChars?: number
  readonly format?: SummaryFormat
  readonly onFailure?: (reason: string) => void
}): Promise<{ readonly summary: Summary; readonly candidate: SummaryChoiceCandidate } | undefined> {
  return runChoicePrompt(
    input.prompt,
    input.candidates,
    input.generate,
    input.model,
    input.maxChars,
    input.format ?? "json",
    input.onFailure,
  )
}
