import type { Plugin } from "@opencode/plugin"

import { estimateCategories } from "../tokens.ts"
import { eligibleMessages, textChars, type MessageLike } from "./select.ts"
import { loadServerSettings } from "./settings.ts"
import { loadState, saveState, withPending, type Block } from "./state.ts"
import { summarize, type GenerateLike, type ModelRefLike } from "./summarize.ts"
import { buildTranscript } from "./transcript.ts"
import { MIN_SOURCE_CHARS, validateSummary } from "./validate.ts"

/** 连续失败达到这个次数后暂停本会话的自动压缩。 */
const MAX_ATTEMPTS = 3
/** 模型窗口缓存时长。 */
const LIMIT_TTL = 60_000

const limitCache = new Map<string, { at: number; limit: number }>()

export interface AutoInput {
  readonly ctx: Plugin.Context
  readonly sessionID: string
  readonly messages: readonly MessageLike[]
  readonly system: readonly { readonly type: string; readonly text: string }[]
  readonly tools: Readonly<Record<string, { readonly description?: string; readonly input?: unknown }>>
  readonly model: ModelRefLike
}

/** 输入：设置 + 模型；输出：实际使用的窗口大小。 */
async function resolveLimit(ctx: Plugin.Context, model: ModelRefLike, setting: "auto" | number): Promise<number | undefined> {
  if (setting !== "auto") return setting
  const key = `${model.providerID}/${model.id}`
  const cached = limitCache.get(key)
  if (cached !== undefined && Date.now() - cached.at < LIMIT_TTL) return cached.limit
  try {
    const result = await ctx.model.list()
    const info = result.data.find((item) => item.providerID === model.providerID && item.id === model.id)
    const limit = info?.limit.context
    if (typeof limit === "number" && limit > 0) {
      limitCache.set(key, { at: Date.now(), limit })
      return limit
    }
  } catch {
    // unknown limit; auto compression stays off
  }
  return undefined
}

/** 输入：system / tools / messages；输出：估算总 token。 */
function estimateTotal(input: AutoInput): number {
  const categories = estimateCategories({
    system: input.system,
    tools: input.tools,
    messages: input.messages,
  })
  return (
    categories.system +
    categories.tools +
    categories.tool +
    categories.text +
    categories.summaries +
    categories.media
  )
}

/**
 * 输入：服务端上下文 + 当前请求。
 * 输出：无。
 * 预期：占用超过 triggerPercent 时生成 pending 块并触发 compaction；不抛错。
 */
export async function maybeAutoCompress(input: AutoInput): Promise<void> {
  try {
    const state = await loadState(input.ctx.storage, input.sessionID)
    if (state.pending || state.autoInFlight) return
    if (state.attempts >= MAX_ATTEMPTS) return

    const settings = await loadServerSettings(input.ctx.storage)
    const limit = await resolveLimit(input.ctx, input.model, settings.contextLimit)
    if (limit === undefined || limit <= 0) return
    if (estimateTotal(input) < limit * (settings.triggerPercent / 100)) return

    const eligible = eligibleMessages(input.messages)
    const sourceChars = textChars(eligible)
    if (eligible.length === 0 || sourceChars < MIN_SOURCE_CHARS) return

    const first = eligible.find((message) => message.id !== undefined)
    const last = [...eligible].reverse().find((message) => message.id !== undefined)
    if (first?.id === undefined || last?.id === undefined) return

    await saveState(input.ctx.storage, input.sessionID, { ...state, autoInFlight: true })

    const summary = await summarize({
      transcript: buildTranscript(eligible),
      sourceChars,
      generate: input.ctx.generate as unknown as GenerateLike,
      model: input.model,
    })
    if (summary === undefined) {
      await saveState(input.ctx.storage, input.sessionID, {
        ...state,
        autoInFlight: false,
        attempts: state.attempts + 1,
        lastError: "auto summary failed",
      })
      return
    }

    const validation = validateSummary(summary, sourceChars)
    if (!validation.ok) {
      await saveState(input.ctx.storage, input.sessionID, {
        ...state,
        autoInFlight: false,
        attempts: state.attempts + 1,
        lastError: validation.message,
      })
      return
    }

    const block: Block = {
      id: `b${(state.blocks.length + 1).toString()}`,
      tier: 1,
      summary,
      fromId: first.id,
      toId: last.id,
      tokensBefore: Math.ceil(sourceChars / 4),
      tokensAfter: Math.ceil(JSON.stringify(summary).length / 4),
      at: Date.now(),
    }
    await saveState(input.ctx.storage, input.sessionID, withPending({ ...state, autoInFlight: true }, block))
    await input.ctx.session.compact({ sessionID: input.sessionID })
  } catch (error) {
    try {
      await saveState(input.ctx.storage, input.sessionID, {
        v: 1,
        blocks: [],
        attempts: 1,
        lastError: String(error),
      })
    } catch {
      // best effort
    }
  }
}
