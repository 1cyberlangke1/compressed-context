import type { Plugin } from "@opencode/plugin"

import { resolveSummaryLimits } from "../shared/settings.ts"
import { mergeTerminalMetadata } from "../shared/stats.ts"
import { renderActiveSummary } from "./active-summary-cache.ts"
import { markCompactionInFlight, resolveLimit } from "./auto.ts"
import { createT1Block } from "./block.ts"
import { distillOnce, isTerminal, planT1Phase } from "./distill.ts"
import { TERMINAL_MESSAGE } from "./events.ts"
import { activeBlocks } from "./render.ts"
import { messageRange, olderMessages, textChars, type MessageLike } from "./select.ts"
import { loadServerSettings } from "./settings.ts"
import { loadState, saveState, type Block, type CompactionPhase, type State } from "./state.ts"
import { buildT1Instruction, sessionGenerator, summarizeInstruction } from "./summarize.ts"
import type { ModelRefLike } from "./summarize.ts"
import { buildTranscript } from "./transcript.ts"
import { saveTranscript } from "./transcript-store.ts"
import { MIN_SOURCE_CHARS, validateSummary } from "./validate.ts"

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
 *       终止时记录 terminal；异常写入 lastError 后重新抛出，交给失败事件。
 */
export async function handleCompaction(ctx: Plugin.Context, event: CompactionEvent): Promise<void> {
  markCompactionInFlight(event.sessionID, true)
  try {
    const state = await loadState(ctx.storage, event.sessionID)
    if (state.terminal !== undefined) throw new Error(state.terminal)
    const settings = await loadServerSettings(ctx.storage)
    // auto 窗口在运行时解析后钳制摘要上限；数字窗口已在保存时校验，这里统一再钳一次。
    const windowTokens = await resolveLimit(ctx, event.model, settings.contextLimit)
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
    ): Promise<void> => {
      const base: State = {
        blocks,
        attempts: state.attempts,
        ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
        ...(phase === undefined ? {} : { phase }),
      }
      const next: State = pending === undefined ? base : { ...base, pending }
      await saveState(
        ctx.storage,
        event.sessionID,
        error === undefined ? next : { ...next, lastError: error },
      )
    }

    // 第二阶段：T2/T3。older 里没有真实消息，或新消息不足以单独做 T1 时合并块。
    // 短消息仍由 OpenCode 原样保留在 recent 里，不会丢内容。
    // 有足够新内容时走下面的 T1：先总结新内容，phase 留到下一次压缩再合并。
    const older = olderMessages(event.messages)
    const olderChars = textChars(older)
    if (state.phase !== undefined && (older.length === 0 || olderChars < MIN_SOURCE_CHARS)) {
      const result = await distillOnce({
        ctx,
        sessionID: event.sessionID,
        state,
        pending: state.pending,
        budgetTokens: limits.budgetTokens,
        summaryBlockChars: limits.blockChars,
        summaryTotalChars: limits.totalChars,
        summaryLanguage: settings.summaryLanguage,
        summaryFormat: settings.summaryFormat,
        phase: state.phase,
        showTimeline: settings.showTimeline,
        showBlockTokens: settings.showBlockTokens,
      })
      await save(result.blocks, result.pending, result.nextPhase, result.error)
      event.result = { summary: result.summary }
      // 摘要链仍超预算且没有合法候选：无法再压，记录终止原因并停止自动压缩。
      if (
        isTerminal(
          result,
          activeBlocks(result.blocks, result.pending),
          limits.budgetTokens,
          limits.totalChars,
        )
      ) {
        await saveState(ctx.storage, event.sessionID, {
          blocks: result.blocks,
          attempts: 0,
          lastError: TERMINAL_MESSAGE,
          terminal: TERMINAL_MESSAGE,
        })
        // 让 TUI 面板能显示终止原因；写失败不影响压缩状态。
        try {
          const session = await ctx.session.get({ sessionID: event.sessionID })
          await ctx.session.update({
            sessionID: event.sessionID,
            metadata: mergeTerminalMetadata(session.metadata, TERMINAL_MESSAGE),
          })
        } catch {
          // best effort
        }
      }
      return
    }

    // 第一阶段：T1。已有 pending（compress 工具）就直接用；
    // 否则用 session 前缀 + 尾部指令生成，保持前缀缓存。
    let pending = state.pending
    if (pending === undefined) {
      const eligible = older
      const transcript = buildTranscript(eligible)
      const sourceChars = transcript.length
      if (eligible.length === 0 || sourceChars < MIN_SOURCE_CHARS) {
        throw new Error("nothing to compress")
      }
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
    const nextPhase = planT1Phase(summary, active, limits.budgetTokens, limits.totalChars)
    await save(state.blocks, pending, nextPhase, undefined)
    event.result = { summary }
  } catch (error) {
    // 把钩子里的真实异常留给失败事件和 TUI；不要只留下“compaction failed”。
    const current = await loadState(ctx.storage, event.sessionID)
    await saveState(ctx.storage, event.sessionID, {
      ...current,
      lastError: error instanceof Error ? (error.stack ?? error.message) : String(error),
    })
    throw error
  } finally {
    markCompactionInFlight(event.sessionID, false)
  }
}
