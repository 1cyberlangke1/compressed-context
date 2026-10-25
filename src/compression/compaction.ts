import type { Plugin } from "@opencode/plugin"

import { resolveForModel, resolveSummaryLimits } from "../shared/settings.ts"
import { renderActiveSummary } from "./active-summary-cache.ts"
import { measuredPromptTokens, resolveLimit } from "./auto.ts"
import { createT1Block } from "./block.ts"
import { distillOnce, planT1Phase } from "./distill.ts"
import { endCompaction, tryBeginCompaction } from "./inflight.ts"
import { activeBlocks } from "./render.ts"
import { messageRange, olderMessages, type MessageLike } from "./select.ts"
import { MIN_SOURCE_CHARS } from "./validate.ts"
import { loadServerSettings } from "./settings.ts"
import { loadState, type Block, type CompactionPhase, type State } from "./state.ts"
import { stateStore } from "./state-store.ts"
import { buildT1Instruction, sessionGenerator, summarizeInstruction } from "./summarize.ts"
import type { ModelRefLike } from "./summarize.ts"
import { buildTranscript } from "./transcript.ts"
import { saveTranscript } from "./transcript-store.ts"
import { validateSummary } from "./validate.ts"

/** compaction 钩子需要的最小事件形状。 */
export interface CompactionEvent {
  readonly sessionID: string
  readonly messages: readonly MessageLike[]
  readonly model: ModelRefLike
  result?: { summary: string }
}

/**
 * 输入：插件上下文 + compaction 事件。
 * 输出：无；预期：T1 生成摘要或 T2/T3 合并块，把结果写回 event.result。
 *       异常写入 lastError 后重新抛出，交给失败事件。
 */
export async function handleCompaction(ctx: Plugin.Context, event: CompactionEvent): Promise<void> {
  // 另一个实例已经给出摘要时不要覆盖；同一事件在多个 hook 间共享 result。
  if (event.result !== undefined) return
  // 同一会话同一时间只允许一个实例生成摘要，避免重复模型调用。
  if (!tryBeginCompaction(event.sessionID)) return
  try {
    const state = await loadState(ctx.storage, event.sessionID)
    // 压缩成功后 nudge 基线要跟着重置到最近一次真实 usage；在钩子开始时取，避免事后上下文被裁掉。
    const baseline = await measuredPromptTokens(ctx, event.sessionID)
    const settings = resolveForModel(await loadServerSettings(ctx), event.model)
    // auto 窗口在运行时解析后钳制摘要上限；数字窗口已在保存时校验，这里统一再钳一次。
    const windowTokens = await resolveLimit(ctx, event.model, settings.contextLimit, event.sessionID)
    const limits = resolveSummaryLimits(settings, windowTokens)
    const renderOptions = {
      showTimeline: settings.showTimeline,
      showBlockTokens: settings.showBlockTokens,
    }

    /** 保存这一层的结果；pending 可选，phase 由下一层决定。 */
    const save = async (
      blocks: readonly Block[],
      pending: Block | undefined,
      phase: CompactionPhase | undefined,
      error: string | undefined,
      rounds: number | undefined,
    ): Promise<void> => {
      await stateStore(ctx.storage).transact(event.sessionID, (current) => {
        // 以锁内的最新状态为基准。钩子开头拿到的快照可能已经过时：
        // 期间别的分支会改写 nudgeCount / lastError，用旧快照整体覆盖会丢更新。
        // 成功必须清掉旧错误：残留的 lastError 会让后续事件对账把「钩子没跑过」误判成真实失败。
        const lastError = error
        const next: State = {
          blocks,
          attempts: current.attempts,
          ...(pending === undefined
            ? {}
            : { pending, pendingAt: Date.now() }),
          ...(phase === undefined ? {} : { phase }),
          ...(lastError === undefined ? {} : { lastError }),
          ...(current.nudgeCount === undefined ? {} : { nudgeCount: current.nudgeCount }),
          ...(rounds === undefined ? {} : { distillRounds: rounds }),
          ...(baseline !== undefined
            ? { nudgeBaselineTokens: baseline }
            : current.nudgeBaselineTokens === undefined
              ? {}
              : { nudgeBaselineTokens: current.nudgeBaselineTokens }),
        }
        return { next, result: undefined }
      })
    }

    // 先按 T1 的真实口径算一次：`buildTranscript` 会把单条工具输出截到 2000 字符，
    // 而 `textChars` 统计的是全文，两者不能混用，否则会出现「以为有内容、实际不够」。
    const older = olderMessages(event.messages)
    const transcript = buildTranscript(older)
    const sourceChars = transcript.length
    // 第二阶段：T2/T3。phase 有值说明摘要已经超出预算、上一轮就排好了层级。
    // 但只有「没有足够的新原文」时才先合并：older 够长时必须先 T1 把新块入链，
    // 否则 active 块数不涨、合并永远没有候选，链会卡死在超预算的单块上。
    if (state.phase !== undefined && (older.length === 0 || sourceChars < MIN_SOURCE_CHARS)) {
      const result = await distillOnce({
        ctx,
        sessionID: event.sessionID,
        state,
        pending: state.pending,
        budgetTokens: limits.budgetTokens,
        recentT1Blocks: settings.recentT1Blocks,
        distillRounds: state.distillRounds ?? 0,
        summaryBlockChars: limits.blockChars,
        summaryTotalChars: limits.totalChars,
        summaryLanguage: settings.summaryLanguage,
        summaryFormat: settings.summaryFormat,
        showTimeline: settings.showTimeline,
        showBlockTokens: settings.showBlockTokens,
      })
      // 模型或校验失败时保留 phase，下一次请求重试同一层；成功且预算回落则由 nextPhase 决定。
      // 但「超预算却没有任何候选」（active<2 或跨层全禁）不能清 phase：
      // 清掉后新 T1 压出来时没人再排下一层，链会永远停在超预算的单块上。
      // 这种情况保留 phase，等下一个 T1 入链后自然有候选可合并。
      const noCandidate = !result.merged && result.error === undefined
      await save(
        result.blocks,
        result.pending,
        result.error !== undefined ? state.phase : noCandidate ? state.phase : result.nextPhase,
        result.error,
        result.distillRounds ?? state.distillRounds,
      )
      event.result = { summary: result.summary }
      // 校验或模型失败时必须走失败路径：否则宿主以为压缩成功、attempts 被清零，
      // state 留着 phase 和下一条 user 消息的再次入队，形成没有任何退避的循环。
      if (result.error !== undefined) throw new Error(result.error)
      // 预算内不会再排下一层；有候选但模型失败时保留 phase 等重试。
      return
    }

    // 第一阶段：T1。只有“真的没有任何可压缩内容”（历史里只剩 checkpoint）才跳过；
    // 只要还有原文就必须压，压不动就让宿主看到失败并重试，不能悄悄跳过。
    if (older.length === 0 || sourceChars === 0) {
      if (state.blocks.length > 0 || state.pending !== undefined) {
        event.result = {
          summary: renderActiveSummary(event.sessionID, state, renderOptions),
        }
      }
      return
    }

    // 已有 pending（compress 工具）就直接用；否则用 session 前缀 + 尾部指令生成，保持前缀缓存。
    let pending = state.pending
    if (pending === undefined) {
      const eligible = older
      let failure = "unknown"
      const summary = await summarizeInstruction({
        prompt: buildT1Instruction({
          maxChars: limits.blockChars,
          totalChars: limits.totalChars,
          language: settings.summaryLanguage,
          format: settings.summaryFormat,
        }),
        sourceChars,
        maxChars: limits.blockChars,
        generate: sessionGenerator(ctx.session, event.sessionID),
        format: settings.summaryFormat,
        onFailure: (reason) => {
          failure = reason
        },
      })
      if (summary === undefined) throw new Error(`compression failed: ${failure}`)
      const validation = validateSummary(summary, sourceChars, undefined, limits.blockChars)
      if (!validation.ok) throw new Error(validation.message)

      const range = messageRange(eligible)
      if (range === undefined) throw new Error("messages are missing ids")

      pending = createT1Block({
        blocks: state.blocks,
        summary,
        fromId: range.fromId,
        toId: range.toId,
        sourceChars,
      })

      // 原文与摘要同生命周期；写盘失败时摘要仍然可用，解压降级为占位符。
      try {
        await saveTranscript(ctx.storage, event.sessionID, pending, eligible)
      } catch {
        // best effort
      }
    }

    // T1 之后再检查预算；没超就不排 T2。
    const active = activeBlocks(state.blocks, pending)
    const summary = renderActiveSummary(
      event.sessionID,
      { ...state, pending },
      renderOptions,
    )
    const nextPhase = planT1Phase(summary, active, limits.budgetTokens)
    await save(state.blocks, pending, nextPhase, undefined, 0)
    event.result = { summary }
  } catch (error) {
    // 把钩子里的真实异常留给失败事件和 TUI；不要只留下“compaction failed”。
    await stateStore(ctx.storage).transact(event.sessionID, (current) => ({
      next: {
        ...current,
        lastError: error instanceof Error ? (error.stack ?? error.message) : String(error),
      },
      result: undefined,
    }))
    throw error
  } finally {
    endCompaction(event.sessionID)
  }
}
