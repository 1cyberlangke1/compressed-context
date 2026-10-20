import type { Plugin } from "@opencode/plugin"
import { Schema } from "effect"

import { resolveSummaryLimits } from "../settings.ts"
import { SummaryFields } from "./schema.ts"
import { RESOLVED_WINDOW_KEY, loadServerSettings } from "./settings.ts"
import type { MessageLike } from "./select.ts"
import { loadState, nextBlockId, nextOrder, saveState, withPending, type Block } from "./state.ts"
import type { Disposable } from "./settings-rpc.ts"
import { buildTranscript } from "./transcript.ts"
import { MIN_SOURCE_CHARS, validateSummary } from "./validate.ts"

const DESCRIPTION =
  "Compress the conversation so far into a structured checkpoint. Call this when the context is getting full. " +
  "It covers every message since the last compressed block, up to the current user message, and replaces them with " +
  "one block. All fields are required; do not call while a compression is already pending. " +
  "Add a short title for the block. " +
  "The block is the only remaining record of those messages, so copy exact paths with line numbers, signatures, the " +
  "code lines that carry the logic, error text, versions, config keys, thresholds, and measured values. " +
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
 * 输入：服务端上下文 + 每个会话最近一次请求的可压消息缓存。
 * 输出：注册 compress 工具。
 * 预期：校验字段与内容量；通过后挂 pending 块并触发 compaction。
 */
export async function registerCompressTool(
  ctx: Plugin.Context,
  cache: ReadonlyMap<string, readonly MessageLike[]>,
): Promise<Disposable> {
  const registration = await ctx.tool.transform((tools) => {
    tools.add({
      name: "compress",
      options: { codemode: false },
      description: DESCRIPTION,
      input: SummaryFields,
      output: Schema.Struct({ block: Schema.String, status: Schema.String }),
      execute: async (input, toolCtx) => {
        const sessionID = toolCtx.sessionID
        const state = await loadState(ctx.storage, sessionID)
        if (state.pending || state.phase !== undefined) return failure("compression already in progress")

        // context 钩子缓存的就是 eligible 消息，这里不能再筛一次。
        const eligible = cache.get(sessionID) ?? []
        const transcript = buildTranscript(eligible)
        const sourceChars = transcript.length
        if (eligible.length === 0) return failure("nothing to compress")
        if (sourceChars < MIN_SOURCE_CHARS) {
          return failure(
            `not enough content to compress (${sourceChars.toString()} chars, min ${MIN_SOURCE_CHARS.toString()})`,
          )
        }

        const settings = await loadServerSettings(ctx.storage)
        const resolved = await ctx.storage.get(RESOLVED_WINDOW_KEY)
        const windowTokens = typeof resolved === "number" && resolved > 0 ? resolved : undefined
        const limits = resolveSummaryLimits(settings, windowTokens)
        const validation = validateSummary(input, sourceChars, undefined, limits.blockChars)
        if (!validation.ok) return failure(validation.message)

        const first = eligible.find((message) => message.id !== undefined)
        const last = [...eligible].reverse().find((message) => message.id !== undefined)
        if (first?.id === undefined || last?.id === undefined) {
          return failure("messages are missing ids")
        }

        const block: Block = {
          id: nextBlockId(state.blocks),
          tier: 1,
          summary: input,
          fromId: first.id,
          toId: last.id,
          tokensBefore: Math.ceil(sourceChars / 4),
          tokensAfter: Math.ceil(JSON.stringify(input).length / 4),
          at: Date.now(),
          order: nextOrder(state.blocks),
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
