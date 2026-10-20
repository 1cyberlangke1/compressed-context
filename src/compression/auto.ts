import type { Plugin } from "@opencode/plugin"

import { MIN_SUMMARY_BLOCK_CHARS, SUMMARY_WINDOW_RESERVE } from "../settings.ts"
import { estimateCategories, totalCategories } from "../tokens.ts"
import { eligibleMessages, messageText, type MessageLike } from "./select.ts"
import { RESOLVED_WINDOW_KEY, loadServerSettings } from "./settings.ts"
import { loadState, saveState } from "./state.ts"
import type { ModelRefLike } from "./summarize.ts"
import { buildTranscript } from "./transcript.ts"
import { MIN_SOURCE_CHARS } from "./validate.ts"

/** 连续失败达到这个次数后暂停本会话的自动压缩。 */
const MAX_ATTEMPTS = 3
/** 模型窗口缓存时长。 */
const LIMIT_TTL = 60_000

const limitCache = new Map<string, { at: number; limit: number }>()

/**
 * 正在执行 compaction 钩子的 session。
 * 压缩钩子内部会调用 session.generate 生成摘要；那个请求同样会经过 context 钩子，
 * 如果不拦住，就会在压缩过程中再次入队压缩，形成递归并让本次摘要失败。
 */
const compactionInFlight = new Set<string>()

/** 输入：sessionID + 是否正在压缩；输出：无；预期：只更新进程内标记。 */
export function markCompactionInFlight(sessionID: string, active: boolean): void {
  if (active) compactionInFlight.add(sessionID)
  else compactionInFlight.delete(sessionID)
}

/** 输入：sessionID；输出：是否正在压缩。 */
export function isCompactionInFlight(sessionID: string): boolean {
  return compactionInFlight.has(sessionID)
}

/**
 * 输入：当前请求消息。
 * 输出：最后一条 user 是否是插件自己的压缩指令。
 * 预期：压缩摘要请求不能再触发自动压缩。
 */
function isCompressionInstruction(messages: readonly MessageLike[]): boolean {
  const lastUser = [...messages].reverse().find((message) => message.role === "user")
  if (lastUser === undefined) return false
  const text = messageText(lastUser).trimStart()
  return (
    text.startsWith("You are writing a checkpoint") ||
    text.startsWith("The checkpoint at the top of the conversation")
  )
}

export interface AutoInput {
  readonly ctx: Plugin.Context
  readonly sessionID: string
  readonly messages: readonly MessageLike[]
  readonly system: readonly { readonly type: string; readonly text: string }[]
  readonly tools: Readonly<Record<string, { readonly description?: string; readonly input?: unknown }>>
  readonly model: ModelRefLike
}

/** 输入：插件上下文 + 模型 key + 窗口；输出：无；预期：写进 storage 供 TUI 读取，失败不影响压缩。 */
async function rememberWindow(ctx: Plugin.Context, key: string, limit: number): Promise<void> {
  try {
    await ctx.storage.set(`window:${key}`, limit)
    await ctx.storage.set(RESOLVED_WINDOW_KEY, limit)
  } catch {
    // best effort：写不进去只影响 TUI 显示，不影响压缩
  }
}

/** 输入：设置 + 模型；输出：实际使用的窗口大小。 */
export async function resolveLimit(ctx: Plugin.Context, model: ModelRefLike, setting: "auto" | number): Promise<number | undefined> {
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
      await rememberWindow(ctx, key, limit)
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
    if (isCompactionInFlight(input.sessionID)) return
    if (isCompressionInstruction(input.messages)) return

    const state = await loadState(input.ctx.storage, input.sessionID)
    if (state.pending) return
    if (state.attempts >= MAX_ATTEMPTS) return
    if (state.terminal !== undefined) return

    const settings = await loadServerSettings(input.ctx.storage)
    if (!settings.autoCompress) return
    const limit = await resolveLimit(input.ctx, input.model, settings.contextLimit)
    if (limit === undefined || limit <= 0) return
    // 窗口小到连最小摘要都放不下：压缩必然失败，别反复入队空压缩。
    if (limit - SUMMARY_WINDOW_RESERVE < MIN_SUMMARY_BLOCK_CHARS) return

    // 已排下一层蒸馏：下一次模型请求就入队 compaction，由 compaction 钩子合并。
    // 不能在 T1 刚结束时入队——那时历史里只剩 checkpoint，OpenCode 会拒绝压缩。
    if (state.phase !== undefined) {
      await input.ctx.session.compact({ sessionID: input.sessionID })
      return
    }

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
