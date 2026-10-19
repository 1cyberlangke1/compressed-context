import type { Plugin } from "@opencode/plugin"

import { estimateCategories, totalCategories } from "../tokens.ts"
import { eligibleMessages, type MessageLike } from "./select.ts"
import { loadServerSettings } from "./settings.ts"
import { loadState, saveState } from "./state.ts"
import type { ModelRefLike } from "./summarize.ts"
import { buildTranscript } from "./transcript.ts"
import { MIN_SOURCE_CHARS } from "./validate.ts"

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
  return totalCategories(
    estimateCategories({
      system: input.system,
      tools: input.tools,
      messages: input.messages,
    }),
  )
}

/**
 * 输入：服务端上下文 + 当前请求。
 * 输出：无。
 * 预期：占用超过 triggerPercent 时只入队 compaction；真正摘要在 compaction 钩子里做。
 */
export async function maybeAutoCompress(input: AutoInput): Promise<void> {
  try {
    const state = await loadState(input.ctx.storage, input.sessionID)
    if (state.pending || state.phase !== undefined) return
    if (state.attempts >= MAX_ATTEMPTS) return

    const settings = await loadServerSettings(input.ctx.storage)
    const limit = await resolveLimit(input.ctx, input.model, settings.contextLimit)
    if (limit === undefined || limit <= 0) return
    const total = estimateTotal(input)
    if (total < limit * (settings.triggerPercent / 100)) return
    const eligible = eligibleMessages(input.messages)
    const sourceChars = buildTranscript(eligible).length
    if (eligible.length === 0 || sourceChars < MIN_SOURCE_CHARS) return

    await input.ctx.session.compact({ sessionID: input.sessionID })
  } catch (error) {
    try {
      const current = await loadState(input.ctx.storage, input.sessionID)
      await saveState(input.ctx.storage, input.sessionID, {
        ...current,
        attempts: current.attempts + 1,
        lastError: String(error),
      })
    } catch {
      // best effort
    }
  }
}
