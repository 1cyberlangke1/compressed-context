import type { Plugin } from "@opencode/plugin"

import type { SummaryFormat, SummaryLanguage } from "../shared/settings.ts"
import { countText } from "../shared/tokens.ts"
import { activeBlocks, renderAll, renderBlock } from "./render.ts"
import { nextBlockId, type Block, type CompactionPhase, type State, type Tier } from "./state.ts"
import { summaryChars, summaryGoal, summaryTitle } from "./summary.ts"
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
  readonly summaryFormat?: SummaryFormat
  readonly phase: Exclude<CompactionPhase, undefined>
  readonly showTimeline?: boolean
  readonly showBlockTokens?: boolean
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

/**
 * 输入：一次蒸馏结果 + active 链 + 预算。
 * 输出：是否已经无法继续压缩（仍超预算，且没有任何合法合并候选）。
 * 预期：与层级无关——全 T3 只要还有两块可合并，或链本身没超预算，都不算终止。
 */
export function isTerminal(
  result: DistillOnceResult,
  active: readonly Block[],
  budgetTokens: number,
  totalChars: number,
): boolean {
  if (result.merged || result.error !== undefined) return false
  if (countText(result.summary) <= budgetTokens && result.summary.length <= totalChars) return false
  return mergeCandidates(active).length === 0
}

/** 输入：块；输出：候选列表里的简短描述。 */
function describe(block: Block): string {
  const goal = summaryGoal(block.summary).replace(/\s+/g, " ").slice(0, 160)
  return `${block.id} T${block.tier.toString()} "${summaryTitle(block.summary)}" — ${goal}`
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
  const renderOptions = {
    showTimeline: input.showTimeline === true,
    showBlockTokens: input.showBlockTokens === true,
  }
  const active = activeBlocks(input.state.blocks, input.pending)
  const currentSummary = renderAll(input.state.blocks, input.pending, renderOptions)
  /** 输入：可选错误原因；输出：未合并的结果。预期：所有「状态没变」分支共用同一形状。 */
  const unchanged = (error?: string): DistillOnceResult => ({
    blocks: input.state.blocks,
    pending: input.pending,
    summary: currentSummary,
    merged: false,
    ...(error === undefined ? {} : { error }),
  })
  const totalChars = input.summaryTotalChars ?? Number.POSITIVE_INFINITY
  if (
    active.length < 2 ||
    (countText(currentSummary) <= input.budgetTokens && currentSummary.length <= totalChars)
  ) {
    return unchanged()
  }

  const candidates = mergeCandidates(active)
  if (candidates.length === 0) {
    return unchanged()
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
    format: input.summaryFormat ?? "json",
  }
  const picked = await summarizeChoiceInstruction({
    prompt: buildMergeInstruction(choices, promptOptions),
    candidates: choices,
    generate: generator,
    ...(input.summaryBlockChars === undefined ? {} : { maxChars: input.summaryBlockChars }),
    format: input.summaryFormat ?? "json",
    onFailure: (reason) => {
      failure = `distill summary failed: ${reason}`
    },
  })
  if (picked === undefined) {
    return unchanged(failure)
  }

  const chosen = candidates[picked.candidate.index - 1]
  if (chosen === undefined) {
    return unchanged("model picked an unknown candidate")
  }

  const validation = validateSummary(
    picked.summary,
    pairTranscript(chosen).length,
    minSummaryChars(chosen.tier),
    input.summaryBlockChars,
  )
  if (!validation.ok) {
    return unchanged(validation.message)
  }

  // 上一层 pending 先转成已落盘块，新合并块保持 pending，交给 compaction 事件转正。
  const working = input.pending === undefined ? [...input.state.blocks] : [...input.state.blocks, input.pending]
  const merged: Block = {
    id: nextBlockId(working),
    tier: chosen.tier,
    summary: picked.summary,
    fromId: chosen.left.fromId,
    toId: chosen.right.toId,
    // 合并块代表的是两个子块覆盖的原始内容，不是子摘要的 token 量。
    sourceTokens: chosen.left.sourceTokens + chosen.right.sourceTokens,
    summaryTokens: Math.ceil(summaryChars(picked.summary) / 4),
    at: Math.max(chosen.left.at, chosen.right.at),
    order: chosen.left.order,
    sourceBlockIds: [chosen.left.id, chosen.right.id],
  }
  const summary = renderAll(working, merged, renderOptions)
  const stillOver =
    countText(summary) > input.budgetTokens || summary.length > totalChars
  // 只要还超预算且还有合法候选就继续合并；T3+T3 产出仍是 T3，直到没有候选或压进预算。
  const nextPhase: CompactionPhase | undefined =
    stillOver && mergeCandidates(activeBlocks(working, merged)).length > 0 ? "t3" : undefined

  return {
    blocks: working,
    pending: merged,
    summary,
    merged: true,
    ...(nextPhase === undefined ? {} : { nextPhase }),
  }
}
