import type { Plugin } from "@opencode/plugin"

import { resolveForModel, resolveSummaryLimits } from "../shared/settings.ts"
import { countText } from "../shared/tokens.ts"
import { renderActiveSummary } from "./active-summary-cache.ts"
import { resolveLimit } from "./auto.ts"
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

/** 摘要链的一次推进：已落盘块、未提交块、已合并轮数。 */
interface Chain {
  readonly blocks: readonly Block[]
  readonly pending: Block | undefined
  readonly rounds: number
}

/** 一个压缩阶段的结果：推进后的链，或本阶段产生的错误。 */
interface StageOutcome {
  readonly chain: Chain
  readonly error?: string
}

/**
 * 输入：插件上下文 + compaction 事件。
 * 输出：无。
 * 预期：按「折入新原文 → 超预算合并」两阶段推进摘要链，把结果写回 event.result；
 *       阶段内失败写入 lastError 后重新抛出，交给失败事件。
 */
export async function handleCompaction(ctx: Plugin.Context, event: CompactionEvent): Promise<void> {
  // 另一个实例已经给出摘要时不要覆盖；同一事件在多个 hook 间共享 result。
  if (event.result !== undefined) return
  // 同一会话同一时间只允许一个实例生成摘要，避免重复模型调用。
  if (!tryBeginCompaction(event.sessionID)) return
  try {
    const state = await loadState(ctx.storage, event.sessionID)
    const settings = resolveForModel(await loadServerSettings(ctx), event.model)
    // auto 窗口在运行时解析后钳制摘要上限；数字窗口已在保存时校验，这里统一再钳一次。
    const windowTokens = await resolveLimit(ctx, event.model, settings.contextLimit, event.sessionID)
    const limits = resolveSummaryLimits(settings, windowTokens)
    const renderOptions = {
      showTimeline: settings.showTimeline,
      showBlockTokens: settings.showBlockTokens,
    }

    /** 输入：链；输出：渲染用的块视图。预期：pending 缺省时省略该键（显式 undefined 不符合精确可选属性）。 */
    const renderInput = (chain: Chain): Pick<State, "blocks" | "pending"> =>
      chain.pending === undefined
        ? { blocks: chain.blocks }
        : { blocks: chain.blocks, pending: chain.pending }

    /** 输入：链；输出：渲染后的完整摘要文本。 */
    const renderChain = (chain: Chain): string =>
      renderActiveSummary(event.sessionID, renderInput(chain), renderOptions)

    /** 保存一次推进后的链；phase 为空表示不再排下一层。 */
    const save = async (
      chain: Chain,
      phase: CompactionPhase | undefined,
      error: string | undefined,
    ): Promise<void> => {
      await stateStore(ctx.storage).transact(event.sessionID, (current) => {
        // 以锁内的最新状态为基准。钩子开头拿到的快照可能已经过时：
        // 期间别的分支会改写 nudgeCount / lastError，用旧快照整体覆盖会丢更新。
        // 成功必须清掉旧错误：残留的 lastError 会让后续事件对账把「钩子没跑过」误判成真实失败。
        const pending = chain.pending
        const next: State = {
          blocks: chain.blocks,
          attempts: current.attempts,
          ...(pending === undefined ? {} : { pending, pendingAt: Date.now() }),
          ...(phase === undefined ? {} : { phase }),
          distillRounds: chain.rounds,
          ...(error === undefined ? {} : { lastError: error }),
          // 成功即重置提醒基线：旧口径按整段 prompt 记账，留着会把新口径的内容量当成「负增长」。
          // 清空后由下一次 maybeNudge 用压缩后的内容量重新建立基线。
          ...(error === undefined
            ? { nudgeCount: 0 }
            : {
                ...(current.nudgeBaselineTokens === undefined
                  ? {}
                  : { nudgeBaselineTokens: current.nudgeBaselineTokens }),
                ...(current.nudgeAnchorTokens === undefined ? {} : { nudgeAnchorTokens: current.nudgeAnchorTokens }),
                ...(current.nudgeCount === undefined ? {} : { nudgeCount: current.nudgeCount }),
              }),
        }
        return { next, result: undefined }
      })
    }

    // 先按 T1 的真实口径算一次：`buildTranscript` 会把单条工具输出截到 2000 字符，
    // 而 `textChars` 统计的是全文，两者不能混用，否则会出现「以为有内容、实际不够」。
    const older = olderMessages(event.messages)
    const sourceChars = buildTranscript(older).length

    /**
     * 阶段一：把新原文折成 T1。
     * 预期：没有新原文时原样通过；摘要已超预算（phase 有值）但新原文不够长时也让位给合并。
     *       older 够长时必须先折进链：fromHook 只保留最近 keep 窗口，落在保留区之外又没进
     *       摘要的原文会同时不在摘要和保留区里，等于丢历史。
     */
    const foldNewSource = async (chain: Chain): Promise<StageOutcome> => {
      const fold =
        older.length > 0 &&
        sourceChars > 0 &&
        (state.phase === undefined || sourceChars >= MIN_SOURCE_CHARS)
      if (!fold) return { chain }
      // 已有 pending（compress 工具）直接沿用，只把连环合并计数归零。
      if (chain.pending !== undefined) return { chain: { ...chain, rounds: 0 } }

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

      const range = messageRange(older)
      if (range === undefined) throw new Error("messages are missing ids")

      const pending = createT1Block({
        blocks: chain.blocks,
        summary,
        fromId: range.fromId,
        toId: range.toId,
        sourceChars,
      })

      // 原文与摘要同生命周期；写盘失败时摘要仍然可用，解压降级为占位符。
      try {
        await saveTranscript(ctx.storage, event.sessionID, pending, older)
      } catch {
        // best effort
      }
      return { chain: { ...chain, pending, rounds: 0 } }
    }

    /**
     * 阶段二：摘要仍超预算时立刻合并一刀。
     * 预期：只留 phase 等下一次请求是不够的——每个回合都有长原文时会一直重做 T1，
     *       合并永远排不上，摘要只增不减（「压完仍超限却不会二次摘要」）。
     *       失败时把已生成的块留在链里并带上错误，由外层统一落盘后抛出。
     */
    const mergeOverBudget = async (chain: Chain): Promise<StageOutcome> => {
      if (countText(renderChain(chain)) <= limits.budgetTokens) return { chain }
      const result = await distillOnce({
        ctx,
        sessionID: event.sessionID,
        state: { ...state, blocks: chain.blocks },
        pending: chain.pending,
        budgetTokens: limits.budgetTokens,
        recentT1Blocks: settings.recentT1Blocks,
        distillRounds: chain.rounds,
        summaryBlockChars: limits.blockChars,
        summaryTotalChars: limits.totalChars,
        summaryLanguage: settings.summaryLanguage,
        summaryFormat: settings.summaryFormat,
        showTimeline: settings.showTimeline,
        showBlockTokens: settings.showBlockTokens,
      })
      const next: Chain = {
        blocks: result.blocks,
        pending: result.pending,
        rounds: result.distillRounds ?? chain.rounds,
      }
      return result.error === undefined ? { chain: next } : { chain: next, error: result.error }
    }

    let chain: Chain = {
      blocks: state.blocks,
      pending: state.pending,
      rounds: state.distillRounds ?? 0,
    }
    let failure: string | undefined
    for (const stage of [foldNewSource, mergeOverBudget]) {
      const outcome = await stage(chain)
      chain = outcome.chain
      if (outcome.error !== undefined) {
        failure = outcome.error
        break
      }
    }

    // 没有块也没有新原文：留给宿主自己判定「没有可压缩内容」。
    if (chain.blocks.length === 0 && chain.pending === undefined && failure === undefined) return

    const summary = renderChain(chain)
    // 失败时保留 phase 让下一次请求重试同一层；成功则由预算决定是否继续排下一层。
    const phase =
      failure === undefined
        ? planT1Phase(summary, activeBlocks(chain.blocks, chain.pending), limits.budgetTokens)
        : 2
    await save(chain, phase, failure)
    event.result = { summary }
    // 校验或模型失败时必须走失败路径：否则宿主以为压缩成功、pending 被转正。
    if (failure !== undefined) throw new Error(failure)
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
