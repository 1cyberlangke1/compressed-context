import type { Plugin } from "@opencode/plugin"

import { resolveForModel, resolveSummaryLimits } from "../shared/settings.ts"
import { mergeTerminalMetadata } from "../shared/stats.ts"
import { updateSessionMetadata } from "./session-metadata.ts"
import { renderActiveSummary } from "./active-summary-cache.ts"
import { measuredPromptTokens, resolveLimit } from "./auto.ts"
import { createT1Block } from "./block.ts"
import { distillOnce, isTerminal, planT1Phase } from "./distill.ts"
import { TERMINAL_MESSAGE } from "./events.ts"
import { endCompaction, tryBeginCompaction } from "./inflight.ts"
import { activeBlocks } from "./render.ts"
import { messageRange, olderMessages, textChars, type MessageLike } from "./select.ts"
import { loadServerSettings } from "./settings.ts"
import { loadState, type Block, type CompactionPhase, type State } from "./state.ts"
import { stateStore } from "./state-store.ts"
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
  // 另一个实例已经给出摘要时不要覆盖；同一事件在多个 hook 间共享 result。
  if (event.result !== undefined) return
  // 同一会话同一时间只允许一个实例生成摘要，避免重复模型调用。
  if (!tryBeginCompaction(event.sessionID)) return
  try {
    const state = await loadState(ctx.storage, event.sessionID)
    if (state.terminal !== undefined) throw new Error(state.terminal)
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

    /** 保存这一层的结果；pending 可选，phase 由下一层决定，overrides 只给终止分支用。 */
    const save = async (
      blocks: readonly Block[],
      pending: Block | undefined,
      phase: CompactionPhase | undefined,
      error: string | undefined,
      overrides: { attempts?: number; terminal?: string } = {},
    ): Promise<void> => {
      await stateStore(ctx.storage).transact(event.sessionID, (current) => {
        // 以锁内的最新状态为基准。钩子开头拿到的快照可能已经过时：
        // 期间别的分支会改写 nudgeCount / terminal / lastError，用旧快照整体覆盖会丢更新。
        const lastError = error ?? current.lastError
        const terminal = overrides.terminal ?? current.terminal
        const next: State = {
          blocks,
          attempts: overrides.attempts ?? current.attempts,
          ...(pending === undefined ? {} : { pending }),
          ...(phase === undefined ? {} : { phase }),
          ...(lastError === undefined ? {} : { lastError }),
          ...(terminal === undefined ? {} : { terminal }),
          ...(current.nudgeCount === undefined ? {} : { nudgeCount: current.nudgeCount }),
          ...(baseline !== undefined
            ? { nudgeBaselineTokens: baseline }
            : current.nudgeBaselineTokens === undefined
              ? {}
              : { nudgeBaselineTokens: current.nudgeBaselineTokens }),
        }
        return { next, result: undefined }
      })
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
        await save(result.blocks, undefined, undefined, TERMINAL_MESSAGE, {
          attempts: 0,
          terminal: TERMINAL_MESSAGE,
        })
        // 让 TUI 面板能显示终止原因；写失败不影响压缩状态。
        try {
          await updateSessionMetadata(ctx, event.sessionID, (metadata) =>
            mergeTerminalMetadata(metadata, TERMINAL_MESSAGE),
          )
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
