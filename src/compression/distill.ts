import type { Plugin } from "@opencode/plugin"

import type { SummaryFormat, SummaryLanguage } from "../shared/settings.ts"
import { countText } from "../shared/tokens.ts"
import { activeBlocks, renderAll, renderBlock } from "./render.ts"
import {
  MAX_DISTILL_ROUNDS,
  MAX_TIER,
  nextBlockId,
  type Block,
  type CompactionPhase,
  type State,
  type Tier,
} from "./state.ts"
import { summaryChars, summaryGoal, summaryTitle } from "./summary.ts"
import {
  buildMergeInstruction,
  sessionGenerator,
  summarizeChoiceInstruction,
  type MergeBlockSummary,
  type SummaryChoiceCandidate,
} from "./summarize.ts"
import { minSummaryChars, validateSummary } from "./validate.ts"

/** 一个待合并的同层段：层 + 段内全部块（按 order 从老到新）。 */
export interface MergeGroup {
  readonly tier: Tier
  readonly blocks: readonly Block[]
}

/** 一个合法选择：合并段内前 index 个块。index 也是模型回答的数字。 */
export interface MergeCandidate {
  readonly index: number
  readonly blocks: readonly Block[]
  readonly tier: Tier
  /** 这些块渲染后的字符数，用于校验摘要确实变小。 */
  readonly sourceChars: number
}

export interface DistillOnceInput {
  readonly ctx: Plugin.Context
  readonly sessionID: string
  readonly state: State
  /** 上一层还没提交的块；合并时可能来自 pending。 */
  readonly pending: Block | undefined
  readonly budgetTokens: number
  /** 保留区：最新这么多个 T1 块不参与合并；预算压力下会自动让位。 */
  readonly recentT1Blocks: number
  /** 自上次 T1 以来已连续合并的刀数；用于刹车，防止连环压缩跑飞。 */
  readonly distillRounds?: number
  readonly summaryBlockChars?: number
  readonly summaryTotalChars?: number
  readonly summaryLanguage?: SummaryLanguage
  readonly summaryFormat?: SummaryFormat
  readonly showTimeline?: boolean
  readonly showBlockTokens?: boolean
}

export interface DistillOnceResult {
  readonly blocks: readonly Block[]
  readonly pending: Block | undefined
  readonly summary: string
  readonly merged: boolean
  readonly nextPhase?: CompactionPhase
  /** 合并后的连续轮数；未合并时沿用输入值。 */
  readonly distillRounds?: number
  readonly error?: string
}



/**
 * 输入：active 链 + 保留压缩块数。
 * 输出：要合并的同层段；链为空时 undefined。
 * 预期：优先选「能真正合两个以上」的段（否则只能自压，块数不减少）；
 *       在所有保留档位里按 可合并 > 摘要占用 > 保留更多 选最优，
 *       所以保留区吃光候选时会一路让位到能合两个块为止。
 */
export function pickMergeGroup(blocks: readonly Block[], recentT1Blocks: number): MergeGroup | undefined {
  const t1Count = blocks.reduce((sum, block) => (block.tier === 1 ? sum + 1 : sum), 0)
  const maxKeep = Math.min(Math.max(0, Math.round(recentT1Blocks)), t1Count)
  let fallback: MergeGroup | undefined
  // 从「保留最多」的档位往下试：第一个能真合两个块以上的档位胜出，
  // 这样保留区只在它把候选吃光时才让位，不会因为"少留几块占用更大"被绕过。
  for (let keep = maxKeep; keep >= 0; keep -= 1) {
    const found = heaviestTierGroup(withoutRecentT1(blocks, keep))
    if (found === undefined) continue
    const group: MergeGroup = { tier: found.tier, blocks: found.blocks }
    if (found.blocks.length >= 2) return group
    fallback ??= group
  }
  return fallback
}

/** 输入：active 链 + 要保留的 T1 块数；输出：剔除最新那几个 T1 之后的链。 */
function withoutRecentT1(blocks: readonly Block[], keep: number): readonly Block[] {
  if (keep <= 0) return blocks
  const protectedIds = new Set<string>()
  for (let index = blocks.length - 1; index >= 0 && protectedIds.size < keep; index -= 1) {
    const block = blocks[index]
    if (block?.tier === 1) protectedIds.add(block.id)
  }
  return blocks.filter((block) => !protectedIds.has(block.id))
}

/**
 * 输入：链（tier 单调不增）。
 * 输出：摘要 token 占用最大的同层段；链为空时 undefined。
 * 预期：同一层一定连续，所以「选层」等于「选段」。平票取更靠左（更老）的段，
 *       保证同一份状态永远得到同一个选择。
 */
function heaviestTierGroup(blocks: readonly Block[]): MergeGroup | undefined {
  let best: { tier: Tier; blocks: Block[]; mass: number } | undefined
  let index = 0
  while (index < blocks.length) {
    const first = blocks[index]
    if (first === undefined) break
    const run: Block[] = [first]
    let cursor = index + 1
    while (cursor < blocks.length) {
      const next = blocks[cursor]
      if (next?.tier !== first.tier) break
      run.push(next)
      cursor += 1
    }
    const mass = run.reduce((sum, block) => sum + block.summaryTokens, 0)
    if (best === undefined || mass > best.mass) best = { tier: first.tier, blocks: run, mass }
    index = cursor
  }
  return best === undefined ? undefined : { tier: best.tier, blocks: best.blocks }
}

/**
 * 输入：选中的同层段。
 * 输出：合并前 1..N 个块的全部选择。
 * 预期：index = 块数，最小值 1 表示「自己压自己」（单个块升一层）。
 */
export function groupCandidates(group: MergeGroup): readonly MergeCandidate[] {
  const tier = Math.min(MAX_TIER, group.tier + 1)
  const candidates: MergeCandidate[] = []
  for (let count = 1; count <= group.blocks.length; count += 1) {
    const picked = group.blocks.slice(0, count)
    candidates.push({ index: count, blocks: picked, tier, sourceChars: transcriptChars(picked) })
  }
  return candidates
}

/** 输入：一组块；输出：它们渲染后的字符数（与实际发给模型的源一致）。 */
function transcriptChars(blocks: readonly Block[]): number {
  return blocks.map((block) => renderBlock(block)).join("\n\n").length
}

/** 输入：块；输出：提示词里描述该块所需的最小信息。 */
function describeBlock(block: Block): MergeBlockSummary {
  return {
    id: block.id,
    tier: block.tier,
    title: summaryTitle(block.summary).trim(),
    goal: summaryGoal(block.summary).replace(/\s+/g, " ").slice(0, 160),
  }
}

/**
 * 输入：当前摘要是否超预算 + active 链。
 * 输出：是否要排下一次合并。
 * 预期：只要还超预算且链非空就排——最短路径是「自己压自己」，所以不再要求有同层伙伴。
 */
export function planT1Phase(
  summary: string,
  active: readonly Block[],
  budgetTokens: number,
): CompactionPhase | undefined {
  return countText(summary) > budgetTokens && active.length > 0 ? 2 : undefined
}

/**
 * 输入：当前状态 + 上一层 pending + 预算 + 保留区。
 * 输出：合并一段后的 blocks / pending / summary。
 * 预期：一次只合并一段（一轮 compaction 一刀），层由算法按占用最大选定，
 *       模型只决定合并前几个块并写出摘要。
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
  // 预算内不动：合并只由「摘要撑爆预算」触发，不做整理性合并。
  if (countText(currentSummary) <= input.budgetTokens) return unchanged()
  const group = pickMergeGroup(active, input.recentT1Blocks)
  if (group === undefined) return unchanged()

  const candidates = groupCandidates(group)
  const choices: SummaryChoiceCandidate[] = candidates.map((candidate) => ({
    index: candidate.index,
    description: `merge first ${candidate.index.toString()} block(s): ${candidate.blocks.map((block) => block.id).join(" + ")}`,
    sourceChars: candidate.sourceChars,
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
    prompt: buildMergeInstruction({
      targetTier: Math.min(MAX_TIER, group.tier + 1),
      blocks: group.blocks.map(describeBlock),
      options: promptOptions,
    }),
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
    chosen.sourceChars,
    minSummaryChars(chosen.tier),
    input.summaryBlockChars,
  )
  if (!validation.ok) {
    return unchanged(validation.message)
  }

  const first = chosen.blocks[0]
  const last = chosen.blocks[chosen.blocks.length - 1]
  if (first === undefined || last === undefined) {
    return unchanged("merge range is empty")
  }

  // 上一层 pending 先转成已落盘块，新合并块保持 pending，交给 compaction 事件转正。
  const working = input.pending === undefined ? [...input.state.blocks] : [...input.state.blocks, input.pending]
  const merged: Block = {
    id: nextBlockId(working),
    tier: chosen.tier,
    // 深度按子块最大深度 +1：tier 封顶后 height 仍在增长，供 UI 渐变使用。
    height: 1 + Math.max(...chosen.blocks.map((block) => block.height)),
    summary: picked.summary,
    fromId: first.fromId,
    toId: last.toId,
    // 合并块代表的是子块覆盖的原始内容，不是子摘要的 token 量。
    sourceTokens: chosen.blocks.reduce((sum, block) => sum + block.sourceTokens, 0),
    summaryTokens: Math.ceil(summaryChars(picked.summary) / 4),
    at: Math.max(...chosen.blocks.map((block) => block.at)),
    order: first.order,
    sourceBlockIds: chosen.blocks.map((block) => block.id),
  }
  const summary = renderAll(working, merged, renderOptions)
  // 预算只按 token 判断：窗口百分比是 token 口径，字符长度不能拿来和它比。
  const stillOver = countText(summary) > input.budgetTokens
  const distillRounds = (input.distillRounds ?? 0) + 1
  // 连环合并要能收敛：还超预算、还有块、且没到本次 T1 的轮数上限才继续。
  const nextPhase: CompactionPhase | undefined =
    stillOver && distillRounds < MAX_DISTILL_ROUNDS && activeBlocks(working, merged).length > 0 ? 2 : undefined

  return {
    blocks: working,
    pending: merged,
    summary,
    merged: true,
    ...(nextPhase === undefined ? {} : { nextPhase }),
    distillRounds,
  }
}
