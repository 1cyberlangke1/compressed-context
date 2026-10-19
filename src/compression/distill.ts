import type { Plugin } from "@opencode/plugin"

import { countText } from "../tokens.ts"
import { activeBlocks, renderAll, renderBlock } from "./render.ts"
import type { SummaryFields } from "./schema.ts"
import { nextBlockId, type Block, type State, type Tier } from "./state.ts"
import {
  summarize,
  summarizeWithChoice,
  type GenerateLike,
  type ModelRefLike,
  type SummaryChoiceCandidate,
} from "./summarize.ts"
import { validateSummary } from "./validate.ts"

/** 一个合法的相邻合并候选。 */
export interface MergeCandidate {
  readonly left: Block
  readonly right: Block
  readonly tier: Tier
}

export interface DistillChainInput {
  readonly ctx: Plugin.Context
  readonly model: ModelRefLike | undefined
  readonly state: State
  /** 刚生成的 T1 或已挂起的块；合并时会被消费。 */
  readonly pending: Block
  readonly budgetTokens: number
}

export interface DistillChainResult {
  readonly blocks: readonly Block[]
  readonly pending: Block
  readonly summary: string
  readonly merges: number
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

/** 输入：active 链；输出：给模型判断“当前任务需要什么”的简短上下文。 */
function taskFor(blocks: readonly Block[]): string {
  const newest = blocks[blocks.length - 1]
  if (newest === undefined) return "(unknown)"
  const open = newest.summary.open_items.length > 0 ? newest.summary.open_items.join("; ") : "(none)"
  return `title: ${newest.summary.title}\ngoal: ${newest.summary.goal}\nopen items: ${open}`
}

/** 输入：块；输出：候选列表里的简短描述。 */
function describe(block: Block): string {
  const goal = block.summary.goal.replace(/\s+/g, " ").slice(0, 160)
  return `${block.id} T${block.tier.toString()} "${block.summary.title}" — ${goal}`
}

/** 输入：候选；输出：这两块的完整 transcript。 */
function pairTranscript(candidate: MergeCandidate): string {
  return `${renderBlock(candidate.left)}\n\n${renderBlock(candidate.right)}`
}

/** 输入：候选 + ctx/model；输出：普通单候选合并摘要。 */
async function summarizePair(
  ctx: Plugin.Context,
  model: ModelRefLike | undefined,
  candidate: MergeCandidate,
): Promise<SummaryFields | undefined> {
  const transcript = pairTranscript(candidate)
  return summarize({
    transcript,
    sourceChars: transcript.length,
    generate: ctx.generate as unknown as GenerateLike,
    ...(model === undefined ? {} : { model }),
    tier: candidate.tier,
  })
}

/**
 * 输入：当前状态 + 刚完成的 pending 块 + 预算。
 * 输出：合并后的 blocks / 最终 pending / summary。
 * 预期：在 compaction 钩子内部同步执行；先检查预算，没超就原样返回，
 *       超了才按单调规则继续 T2/T3，全部做完才让调用方返回。
 */
export async function distillChain(input: DistillChainInput): Promise<DistillChainResult> {
  let working = [...input.state.blocks]
  let pending = input.pending
  let merges = 0
  let error: string | undefined

  while (countText(renderAll(working, pending)) > input.budgetTokens) {
    const active = activeBlocks(working, pending)
    const candidates = mergeCandidates(active)
    if (candidates.length === 0) break

    const first = candidates[0]
    if (first === undefined) break
    const transcripts = candidates.map(pairTranscript)
    let chosen: MergeCandidate
    let summary: SummaryFields | undefined

    if (candidates.length === 1) {
      chosen = first
      summary = await summarizePair(input.ctx, input.model, chosen)
    } else {
      const choices: SummaryChoiceCandidate[] = candidates.map((candidate, index) => ({
        index: index + 1,
        description: `${describe(candidate.left)} + ${describe(candidate.right)} → T${candidate.tier.toString()}`,
        sourceChars: transcripts[index]?.length ?? 0,
        tier: candidate.tier,
      }))
      const picked = await summarizeWithChoice({
        context: active.map(renderBlock).join("\n\n"),
        task: taskFor(active),
        candidates: choices,
        generate: input.ctx.generate as unknown as GenerateLike,
        ...(input.model === undefined ? {} : { model: input.model }),
      })
      if (picked !== undefined) {
        const index = picked.candidate.index - 1
        const candidate = candidates[index]
        if (candidate === undefined) {
          error = "model picked an unknown candidate"
          break
        }
        chosen = candidate
        summary = picked.summary
      } else {
        // 模型连“选择 + 摘要”都写坏时，回退最前面候选，再走普通摘要一次。
        chosen = first
        summary = await summarizePair(input.ctx, input.model, chosen)
      }
    }

    if (summary === undefined) {
      error = "distill summary failed"
      break
    }

    const validation = validateSummary(summary, pairTranscript(chosen).length)
    if (!validation.ok) {
      error = validation.message
      break
    }

    // 旧 pending 先转成已落盘块，新合并块保持 pending，交给 compaction 事件转正。
    working = [...working, pending]
    const merged: Block = {
      id: nextBlockId(working),
      tier: chosen.tier,
      summary,
      fromId: chosen.left.fromId,
      toId: chosen.right.toId,
      tokensBefore: chosen.left.tokensAfter + chosen.right.tokensAfter,
      tokensAfter: Math.ceil(JSON.stringify(summary).length / 4),
      at: Date.now(),
      order: chosen.left.order,
      sourceBlockIds: [chosen.left.id, chosen.right.id],
    }
    pending = merged
    merges += 1
  }

  return {
    blocks: working,
    pending,
    summary: renderAll(working, pending),
    merges,
    ...(error === undefined ? {} : { error }),
  }
}
