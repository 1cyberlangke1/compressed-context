import type { Plugin } from "@opencode/plugin"
import { Schema } from "effect"

import { resolveSummaryLimits } from "../shared/settings.ts"
import { createT1Block } from "./block.ts"
import { toSummary } from "./normalize.ts"
import { SummaryInput } from "./schema.ts"
import { RESOLVED_WINDOW_KEY, loadServerSettings, windowKey } from "./settings.ts"
import { eligibleMessages, messageRange, type MessageLike } from "./select.ts"
import { sessionMessagesToMessageLikes } from "./session-message.ts"
import { loadState, saveState, withPending } from "./state.ts"
import type { Disposable } from "./settings-rpc.ts"
import { buildTranscript } from "./transcript.ts"
import { saveTranscript } from "./transcript-store.ts"
import { MIN_SOURCE_CHARS, validateSummary } from "./validate.ts"

const DESCRIPTION =
  "Compress the conversation so far into a structured checkpoint. Call this when the context is getting full. " +
  "It covers every message since the last compressed block, up to the current user message, and replaces them with " +
  "one block. In JSON mode provide `goal` plus the optional fields; in Markdown mode provide `markdown`. Omit any " +
  "optional field that has no real content instead of inventing entries. Do not call while a compression is already " +
  "pending. " +
  "Add a short title if useful. " +
  "The block is the only remaining record of those messages, so copy exact paths with line numbers, signatures, the " +
  "code lines that carry the logic, error text, versions, config keys, thresholds, and measured values. " +
  "Use `files` only for real file paths; put config keys and function names in `facts`. " +
  "Put work in `progress.completed` only when it was actually finished; plans go in `progress.active` or `open_items`. " +
  "Give the reason for each decision, keep the objective and any pivots, why important actions were taken, unanswered " +
  "questions, and work the user still expects. Describe the past as past, not as a new instruction. " +
  "Leave out logs, repeated reads, exploration that produced nothing, abandoned attempts (one line on why), and " +
  "repeated status checks. If space is tight, keep objective and constraints first, then decisions and reasons, then " +
  "exact technical facts, then conclusions, then lessons. Write short factual entries, not prose."

function failure(message: string) {
  return {
    output: { block: "", status: "error" },
    content: `ERROR: ${message}`,
    metadata: { error: true },
  }
}

/**
 * 输入：服务端上下文。
 * 输出：注册 compress 工具。
 * 预期：执行时从会话上下文按需取消息，不再把整段历史常驻内存。
 */
export async function registerCompressTool(
  ctx: Plugin.Context,
  legacyCache?: ReadonlyMap<string, readonly MessageLike[]>,
): Promise<Disposable> {
  const registration = await ctx.tool.transform((tools) => {
    tools.add({
      name: "compress",
      options: { codemode: false },
      description: DESCRIPTION,
      input: SummaryInput,
      output: Schema.Struct({ block: Schema.String, status: Schema.String }),
      execute: async (input, toolCtx) => {
        const sessionID = toolCtx.sessionID
        const state = await loadState(ctx.storage, sessionID)
        if (state.terminal !== undefined) return failure(state.terminal)
        if (state.pending || state.phase !== undefined) return failure("compression already in progress")

        let eligible: readonly MessageLike[] | undefined
        try {
          const raw = await ctx.session.context({ sessionID })
          eligible = eligibleMessages(sessionMessagesToMessageLikes(raw))
        } catch {
          // 兼容旧测试替身；生产路径不传 legacyCache。
          eligible = legacyCache === undefined ? undefined : (legacyCache.get(sessionID) ?? [])
        }
        if (eligible === undefined) return failure("failed to read session context")
        const transcript = buildTranscript(eligible)
        const sourceChars = transcript.length
        if (eligible.length === 0) return failure("nothing to compress")
        if (sourceChars < MIN_SOURCE_CHARS) {
          return failure(
            `not enough content to compress (${sourceChars.toString()} chars, min ${MIN_SOURCE_CHARS.toString()})`,
          )
        }

        const settings = await loadServerSettings(ctx.storage)
        if (!settings.enableCompressTool) return failure("compress tool is disabled in settings")
        // 优先用当前会话模型自己的窗口；取不到再回退最近一次解析值。
        let windowTokens: number | undefined
        try {
          const session = await ctx.session.get({ sessionID })
          const model = session.model
          const stored =
            model === undefined ? undefined : await ctx.storage.get(windowKey(model.providerID, model.id))
          if (typeof stored === "number" && stored > 0) windowTokens = stored
        } catch {
          // 会话或模型未知：回退到最近一次解析值
        }
        if (windowTokens === undefined) {
          const resolved = await ctx.storage.get(RESOLVED_WINDOW_KEY)
          if (typeof resolved === "number" && resolved > 0) windowTokens = resolved
        }
        const limits = resolveSummaryLimits(settings, windowTokens)
        const summary = toSummary(input, settings.summaryFormat)
        if (summary === undefined) return failure("invalid summary shape")
        const validation = validateSummary(summary, sourceChars, undefined, limits.blockChars)
        if (!validation.ok) return failure(validation.message)

        const range = messageRange(eligible)
        if (range === undefined) {
          return failure("messages are missing ids")
        }

        const block = createT1Block({
          blocks: state.blocks,
          summary,
          fromId: range.fromId,
          toId: range.toId,
          sourceChars,
        })

        // transcript 落盘失败不应阻断摘要；解压时会降级为占位符。
        try {
          await saveTranscript(ctx.storage, sessionID, block, eligible)
        } catch {
          // best effort
        }

        await saveState(ctx.storage, sessionID, withPending(state, block))
        try {
          await ctx.session.compact({ sessionID })
        } catch (error) {
          await saveState(ctx.storage, sessionID, { ...state, lastError: String(error) })
          return failure(`failed to start compaction: ${String(error)}`)
        }

        return {
          output: { block: block.id, status: "queued" },
          content: `queued compression ${block.id}`,
        }
      },
    })
  })
  return registration
}
