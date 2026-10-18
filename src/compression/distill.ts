import type { Plugin } from "@opencode/plugin"

import { countText } from "../tokens.ts"
import { activeBlocks, renderAll, renderBlock } from "./render.ts"
import { loadServerSettings } from "./settings.ts"
import { dropPending, loadState, saveState, withPending, type Block, type Tier } from "./state.ts"
import { summarize, type GenerateLike, type ModelRefLike } from "./summarize.ts"
import { validateSummary } from "./validate.ts"

/** 同一次事件级联里最多连续合并的轮数；新的请求入口会重置。 */
export const MAX_DISTILL_ROUNDS = 3

/** 一个合法的相邻合并候选。 */
export interface MergeCandidate {
  readonly left: Block
  readonly right: Block
  readonly tier: Tier
}

export interface DistillInput {
  readonly ctx: Plugin.Context
  readonly sessionID: string
  readonly model: ModelRefLike | undefined
  /** 新的请求入口重置本轮上限；事件级联不重置。 */
  readonly resetDepth?: boolean
}

const inFlight = new Set<string>()

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

function choicePrompt(candidates: readonly MergeCandidate[], task: string): string {
  const describe = (block: Block): string => {
    const goal = block.summary.goal.replace(/\s+/g, " ").slice(0, 160)
    return `${block.id} T${block.tier.toString()} "${block.summary.title}" — ${goal}`
  }
  const lines = candidates.map(
    (candidate, index) => `${(index + 1).toString()}. ${describe(candidate.left)} + ${describe(candidate.right)} → T${candidate.tier.toString()}`,
  )
  return [
    "A checkpoint summary chain has exceeded its token budget.",
    "The algorithm has already decided that one adjacent pair must be merged and has listed every legal pair below.",
    "Choose the ONE pair whose content is least needed for the current task. Do not choose any other pair.",
    "",
    "Current task:",
    task,
    "",
    "Candidates (oldest first):",
    ...lines,
    "",
    'Reply with ONLY JSON: {"candidate": 1}',
  ].join("\n")
}

function parseChoice(text: string): number | undefined {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
  try {
    const value: unknown = JSON.parse(cleaned)
    if (typeof value !== "object" || value === null) return undefined
    const candidate = (value as Record<string, unknown>)["candidate"]
    return typeof candidate === "number" && Number.isInteger(candidate) ? candidate : undefined
  } catch {
    return undefined
  }
}

/** 输入：候选 + 当前任务；输出：模型选择的候选；失败返回 undefined。 */
async function chooseCandidate(
  input: DistillInput,
  candidates: readonly MergeCandidate[],
  task: string,
): Promise<MergeCandidate | undefined> {
  const generate = input.ctx.generate as unknown as GenerateLike
  const prompt = choicePrompt(candidates, task)
  try {
    const response = await generate.text(input.model === undefined ? { prompt } : { prompt, model: input.model })
    const picked = parseChoice(response.text)
    if (picked === undefined || picked < 1 || picked > candidates.length) return undefined
    return candidates[picked - 1]
  } catch {
    return undefined
  }
}

/**
 * 输入：服务端上下文 + sessionID + 模型。
 * 输出：true 表示“摘要链已超预算或正在处理”，调用方应跳过新的 T1。
 * 预期：纯算法决定是否合并以及候选；只有多个合法候选时才让模型选一个。
 */
export async function maybeDistill(input: DistillInput): Promise<boolean> {
  if (inFlight.has(input.sessionID)) return true
  inFlight.add(input.sessionID)
  try {
    let state = await loadState(input.ctx.storage, input.sessionID)
    if (state.pending) return true
    if (input.resetDepth === true && (state.distillDepth ?? 0) > 0) {
      state = { ...state, distillDepth: 0 }
      await saveState(input.ctx.storage, input.sessionID, state)
    }

    const settings = await loadServerSettings(input.ctx.storage)
    const active = activeBlocks(state.blocks)
    const overBudget = countText(renderAll(state.blocks)) > settings.summaryBudgetTokens
    if (!overBudget) return false
    if ((state.distillDepth ?? 0) >= MAX_DISTILL_ROUNDS) return true
    if (active.length < 2) return true

    const candidates = mergeCandidates(active)
    if (candidates.length === 0) return true
    const chosen =
      candidates.length === 1
        ? candidates[0]
        : ((await chooseCandidate(input, candidates, taskFor(active))) ?? candidates[0])
    if (chosen === undefined) return true

    const transcript = `${renderBlock(chosen.left)}\n\n${renderBlock(chosen.right)}`
    const summary = await summarize({
      transcript,
      sourceChars: transcript.length,
      generate: input.ctx.generate as unknown as GenerateLike,
      ...(input.model === undefined ? {} : { model: input.model }),
      tier: chosen.tier,
    })
    if (summary === undefined) {
      await saveState(input.ctx.storage, input.sessionID, { ...state, lastError: "distill summary failed" })
      return true
    }

    const validation = validateSummary(summary, transcript.length)
    if (!validation.ok) {
      await saveState(input.ctx.storage, input.sessionID, { ...state, lastError: validation.message })
      return true
    }

    const block: Block = {
      id: `b${(state.blocks.length + 1).toString()}`,
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

    await saveState(input.ctx.storage, input.sessionID, withPending(state, block))
    try {
      await input.ctx.session.compact({ sessionID: input.sessionID })
    } catch (error) {
      const current = await loadState(input.ctx.storage, input.sessionID)
      await saveState(input.ctx.storage, input.sessionID, dropPending(current, String(error), false))
    }
    return true
  } catch (error) {
    try {
      const current = await loadState(input.ctx.storage, input.sessionID)
      await saveState(input.ctx.storage, input.sessionID, { ...current, lastError: String(error) })
    } catch {
      // best effort
    }
    return true
  } finally {
    inFlight.delete(input.sessionID)
  }
}
