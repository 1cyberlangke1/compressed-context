import type { Plugin } from "@opencode/plugin"

import type { SummaryLanguage } from "../settings.ts"
import { countText } from "../tokens.ts"
import { activeBlocks, renderAll, renderBlock } from "./render.ts"
import { nextBlockId, type Block, type CompactionPhase, type State, type Tier } from "./state.ts"
import {
  buildMergeInstruction,
  sessionGenerator,
  summarizeChoiceInstruction,
  type SummaryChoiceCandidate,
} from "./summarize.ts"
import { minSummaryChars, validateSummary } from "./validate.ts"

/** 一个合法的相邻合并候选。 */
export interface MergeCandidate {
  readonly left: Block
  readonly right: Block
  readonly tier: Tier
}

export interface DistillOnceInput {
  readonly ctx: Plugin.Context
  readonly sessionID: string
  readonly state: State
  /** 上一层还没提交的块；T2/T3 钩子里可能来自 pending。 */
  readonly pending: Block | undefined
  readonly budgetTokens: number
  readonly summaryBlockChars?: number
  readonly summaryTotalChars?: number
  readonly summaryLanguage?: SummaryLanguage
  readonly phase: Exclude<CompactionPhase, undefined>
}

export interface DistillOnceResult {
  readonly blocks: readonly Block[]
  readonly pending: Block | undefined
  readonly summary: string
  readonly merged: boolean
  readonly nextPhase?: CompactionPhase
  readonly error?: string
}

/** 输入：active 链；输出：所有保持 tier 单调不增的相邻合并候选。 */
export function mergeCandidates(blocks: readonly Block[]): readonly MergeCandidate[] {
  const candidates: MergeCandidate[] = []
  for (let index = 0; index < blocks.length - 1; index += 1) {
    const left = blocks[index]
    const right = blocks[index + 1]
    if (left === undefined || right === undefined) continue
    const tier = Math.min(3, Math.max(left.tier, right.tier) + 1) as Tier
    const previous = blocks[index - 1]
    const next = blocks[index + 2]
    if (previous !== undefined && previous.tier < tier) continue
    if (next !== undefined && tier < next.tier) continue
    candidates.push({ left, right, tier })
  }
  return candidates
}

/** 输入：T1 后的摘要链；输出：是否要自动排 T2。 */
export function planT1Phase(
  summary: string,
  active: readonly Block[],
  budgetTokens: number,
  totalChars: number = Number.POSITIVE_INFINITY,
): CompactionPhase | undefined {
  return (countText(summary) > budgetTokens || summary.length > totalChars) &&
    mergeCandidates(active).length > 0
    ? "t2"
    : undefined
}

/** 输入：块；输出：候选列表里的简短描述。 */
function describe(block: Block): string {
  const goal = block.summary.goal.replace(/\s+/g, " ").slice(0, 160)
  return `${block.id} T${block.tier.toString()} "${block.summary.title}" — ${goal}`
}

/** 输入：候选；输出：这两块的完整 transcript（只用于本地校验，不发给模型）。 */
function pairTranscript(candidate: MergeCandidate): string {
  return `${renderBlock(candidate.left)}\n\n${renderBlock(candidate.right)}`
}

/**
 * 输入：当前状态 + 上一层 pending + 预算 + 本次是 T2 还是 T3。
 * 输出：只合并一对后的 blocks / pending / summary。
 * 预期：每层只合一次；模型在会话前缀后只看到追加的候选指令。
 */
export async function distillOnce(input: DistillOnceInput): Promise<DistillOnceResult> {
  const active = activeBlocks(input.state.blocks, input.pending)
  const currentSummary = renderAll(input.state.blocks, input.pending)
  const totalChars = input.summaryTotalChars ?? Number.POSITIVE_INFINITY
  if (
    active.length < 2 ||
    (countText(currentSummary) <= input.budgetTokens && currentSummary.length <= totalChars)
  ) {
    return { blocks: input.state.blocks, pending: input.pending, summary: currentSummary, merged: false }
  }

  const candidates = mergeCandidates(active)
  if (candidates.length === 0) {
    return { blocks: input.state.blocks, pending: input.pending, summary: currentSummary, merged: false }
  }

  const choices: SummaryChoiceCandidate[] = candidates.map((candidate, index) => ({
    index: index + 1,
    description: `${describe(candidate.left)} + ${describe(candidate.right)} → T${candidate.tier.toString()}`,
    sourceChars: pairTranscript(candidate).length,
    tier: candidate.tier,
  }))

  const generator = sessionGenerator(input.ctx.session, input.sessionID)
  let failure = "distill summary failed"
  const promptOptions = {
    ...(input.summaryBlockChars === undefined ? {} : { maxChars: input.summaryBlockChars }),
    ...(input.summaryTotalChars === undefined ? {} : { totalChars: input.summaryTotalChars }),
    ...(input.summaryLanguage === undefined ? {} : { language: input.summaryLanguage }),
  }
  const picked = await summarizeChoiceInstruction({
    prompt: buildMergeInstruction(choices, promptOptions),
    candidates: choices,
    generate: generator,
    ...(input.summaryBlockChars === undefined ? {} : { maxChars: input.summaryBlockChars }),
    onFailure: (reason) => {
      failure = `distill summary failed: ${reason}`
    },
  })
  if (picked === undefined) {
    return {
      blocks: input.state.blocks,
      pending: input.pending,
      summary: currentSummary,
      merged: false,
      error: failure,
    }
  }

  const chosen = candidates[picked.candidate.index - 1]
  if (chosen === undefined) {
    return {
      blocks: input.state.blocks,
      pending: input.pending,
      summary: currentSummary,
      merged: false,
      error: "model picked an unknown candidate",
    }
  }

  const validation = validateSummary(
    picked.summary,
    pairTranscript(chosen).length,
    minSummaryChars(chosen.tier),
    input.summaryBlockChars,
  )
  if (!validation.ok) {
    return {
      blocks: input.state.blocks,
      pending: input.pending,
      summary: currentSummary,
      merged: false,
      error: validation.message,
    }
  }

  // 上一层 pending 先转成已落盘块，新合并块保持 pending，交给 compaction 事件转正。
  const working = input.pending === undefined ? [...input.state.blocks] : [...input.state.blocks, input.pending]
  const merged: Block = {
    id: nextBlockId(working),
    tier: chosen.tier,
    summary: picked.summary,
    fromId: chosen.left.fromId,
    toId: chosen.right.toId,
    tokensBefore: chosen.left.tokensAfter + chosen.right.tokensAfter,
    tokensAfter: Math.ceil(JSON.stringify(picked.summary).length / 4),
    at: Date.now(),
    order: chosen.left.order,
    sourceBlockIds: [chosen.left.id, chosen.right.id],
  }
  const summary = renderAll(working, merged)
  const nextPhase: CompactionPhase | undefined =
    input.phase === "t2" &&
    (countText(summary) > input.budgetTokens || summary.length > totalChars) &&
    mergeCandidates(activeBlocks(working, merged)).length > 0
      ? "t3"
      : undefined

  return {
    blocks: working,
    pending: merged,
    summary,
    merged: true,
    ...(nextPhase === undefined ? {} : { nextPhase }),
  }
}
