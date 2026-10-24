import type { Plugin } from "@opencode/plugin"

import { formatTokens } from "../shared/format.ts"
import { MIN_SUMMARY_BLOCK_CHARS, SUMMARY_WINDOW_RESERVE, resolveForModel, resolveSummaryLimits, triggerTokens } from "../shared/settings.ts"
import { countText, estimateCategories, totalCategories } from "../shared/tokens.ts"
import {
  endCompactionRequest,
  isCompactionInFlight,
  tryBeginCompactionRequest,
} from "./inflight.ts"
import { renderAll } from "./render.ts"
import { eligibleMessages, messageText, type MessageLike } from "./select.ts"
import {
  EFFECTIVE_WINDOW_KEY,
  RESOLVED_WINDOW_KEY,
  effectiveWindowKey,
  loadServerSettings,
  resolvedWindowKey,
  windowKey,
} from "./settings.ts"
import { PENDING_TIMEOUT_MS, MAX_COMPRESSION_ATTEMPTS, clearPhase, expireStalePending, loadState, type State } from "./state.ts"
import { stateStore } from "./state-store.ts"
import type { ModelRefLike } from "./summarize.ts"
import { buildTranscript } from "./transcript.ts"
import { MIN_SOURCE_CHARS } from "./validate.ts"

/** 模型窗口缓存时长。 */
const LIMIT_TTL = 60_000

const limitCache = new Map<string, { at: number; limit: number }>()

/** 入队后等待压缩完成的最大时长；OpenCode 原生压缩在 step 循环里同步等，这里对齐该语义。 */
export const COMPACTION_WAIT_MS = 5 * 60_000
/** pending 已生成后，等事件转正的额外窗口；事件丢失时不至于卡满 5 分钟。 */
const COMPACTION_COMMIT_WAIT_MS = 10_000
/** 等待轮询间隔。 */
const COMPACTION_POLL_MS = 200

/**
 * 输入：服务端上下文 + sessionID + 入队前的 state 快照。
 * 输出：无。
 * 预期：阻塞直到该次 compaction 落地——blocks 增多（事件已把 pending 转正）、
 *       lastError 出现或变化（失败）、或等待超时。pending 已出现时再给事件一个短窗口，
 *       避免下一步在 pending 尚未转正时启动；超时不抛错，放行请求。
 */
export async function waitForCompaction(
  ctx: Plugin.Context,
  sessionID: string,
  before: { blocks: number; lastError: string | undefined },
): Promise<void> {
  const deadline = Date.now() + COMPACTION_WAIT_MS
  let pendingSince: number | undefined
  while (Date.now() < deadline) {
    const state = await loadState(ctx.storage, sessionID)
    // blocks 增多 = 事件已把 pending 转正，下一步可以安全地从新上下文开始。
    const settled = state.blocks.length > before.blocks
    const failed = state.lastError !== undefined && state.lastError !== before.lastError
    if (settled || failed) {
      // 钩子的 finally 可能还没清 in-flight；等它清掉再放行，否则下一步 nudge 会被跳过。
      while (isCompactionInFlight(sessionID) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, COMPACTION_POLL_MS))
      }
      return
    }
    if (state.pending !== undefined) {
      // 钩子已生成块，但事件还没转正；再等一小段，避免下一次 context hook 被 pending 挡掉。
      pendingSince ??= Date.now()
      if (Date.now() - pendingSince > COMPACTION_COMMIT_WAIT_MS) return
    }
    await new Promise((resolve) => setTimeout(resolve, COMPACTION_POLL_MS))
  }
}

/**
 * 输入：storage；输出：最近一次解析到的「生效窗口」。
 * 预期：`resolveLimit` 在缓存里保存的是原生窗口，settings 里的数字上限
 *       `contextLimit=100000` 只有在生效窗口里才体现；缺失时 undefined。
 */
async function effectiveLimit(
  storage: Plugin.Context["storage"],
  sessionID: string,
): Promise<number | undefined> {
  const scoped = await storage.get(effectiveWindowKey(sessionID))
  if (typeof scoped === "number" && scoped > 0) return scoped
  // 兼容旧数据：没有会话级值时退回旧的全局值。
  const stored = await storage.get(EFFECTIVE_WINDOW_KEY)
  return typeof stored === "number" && stored > 0 ? stored : undefined
}

/**
 * 输入：会话状态。
 * 输出：本轮自动压缩是否必须跳过。
 * 预期：有 pending 或已达尝试上限时不再入队；没有「终止态」——
 *       摘要压不动只是这一次没有候选，新消息进来后仍会继续压缩。
 */
function blockedByState(state: State): boolean {
  if (state.attempts >= MAX_COMPRESSION_ATTEMPTS) return true
  // pending 卡住超过兜底时长视为事件丢失：不再挡压缩，等这次入队走完整体生命周期。
  if (state.pending !== undefined) {
    const marked = state.pendingAt
    return marked === undefined || Date.now() - marked < PENDING_TIMEOUT_MS
  }
  return false
}

/**
 * 输入：会话状态 + 合并后的设置 + 生效窗口。
 * 输出：摘要链是否真的超过 token 预算。
 * 预期：只按 countText 判断。窗口百分比是 token 口径，字符数不能拿来比较。
 */
function summaryOverBudget(
  state: State,
  settings: ReturnType<typeof resolveForModel>,
  windowTokens: number | undefined,
): boolean {
  const limits = resolveSummaryLimits(settings, windowTokens)
  const summary = renderAll(state.blocks, state.pending, {
    showTimeline: settings.showTimeline,
    showBlockTokens: settings.showBlockTokens,
  })
  return countText(summary) > limits.budgetTokens
}

/**
 * 输入：插件上下文 + sessionID + 会话状态 + 设置 + 窗口。
 * 输出：无。
 * 预期：摘要回到预算内时清掉残留的 phase。phase 不清会让每个 step 都入队一次压缩，
 *       完全绕过 triggerPercent（之前的「疯狂触发」）。
 */
async function clearStalePhaseIfWithinBudget(
  ctx: Plugin.Context,
  sessionID: string,
  state: State,
  settings: ReturnType<typeof resolveForModel>,
  windowTokens: number | undefined,
): Promise<void> {
  if (summaryOverBudget(state, settings, windowTokens)) return
  await stateStore(ctx.storage).transact(sessionID, (current) => {
    if (current.phase === undefined) return { result: undefined }
    return { next: clearPhase(current), result: undefined }
  })
}

/**
 * 输入：服务端上下文 + sessionID。
 * 输出：最近一次 completed compaction 之后是否出现了新的 user 消息。
 * 预期：没有 compaction 或读不到历史时返回 true，保持旧触发行为；
 *       有 completed compaction 且后面只有 assistant/tool 消息时返回 false，
 *       避免同一轮压缩刚结束又入队一次空压缩。
 */
async function hasUserSinceCompaction(ctx: Plugin.Context, sessionID: string): Promise<boolean> {
  try {
    const messages = await ctx.session.context({ sessionID })
    let latest = -1
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]
      if (message?.type === "compaction" && message.status === "completed") latest = index
    }
    if (latest < 0) return true
    return messages.slice(latest + 1).some((message) => message.type === "user" && message.text.trim().length > 0)
  } catch {
    // 读不到历史时不阻断压缩；OpenCode 会在钩子里给出真实错误。
    return true
  }
}

/**
 * 输入：插件上下文 + sessionID。
 * 输出：过期兜底后的最新状态。
 * 预期：pending 挂起超过 PENDING_TIMEOUT_MS 时强制转正写回；其余原样读。
 *       事件丢失时靠这条路径解卡，而不是永远挡住自动压缩。
 */
async function expireStalePendingStorage(ctx: Plugin.Context, sessionID: string): Promise<State> {
  const state = await loadState(ctx.storage, sessionID)
  const expired = expireStalePending(state, Date.now())
  if (expired !== state) {
    await stateStore(ctx.storage).transact(sessionID, (current) => ({
      next: expireStalePending(current, Date.now()),
      result: undefined,
    }))
    return expireStalePending(await loadState(ctx.storage, sessionID), Date.now())
  }
  return state
}

/**
 * 输入：服务端上下文 + sessionID + 捕获到的错误。
 * 输出：无。
 * 预期：累加 attempts 并记录 lastError；写状态失败时忽略，避免掩盖原始错误。
 */
async function recordCompressionFailure(
  ctx: Plugin.Context,
  sessionID: string,
  error: unknown,
): Promise<void> {
  try {
    // 压缩钩子自己会记录真实错误；它运行期间不要让等待超时之类的错误覆盖。
    if (isCompactionInFlight(sessionID)) return
    await stateStore(ctx.storage).transact(sessionID, (current) => ({
      next: {
        ...current,
        attempts: current.attempts + 1,
        lastError: String(error),
      },
      result: undefined,
    }))
  } catch {
    // best effort
  }
}

/**
 * 输入：`session.step.ended` 事件带的 usage + 服务端上下文 + sessionID。
 * 输出：无。
 * 预期：tool loop 的后续 step 不触发 context hook，这里是唯一能在同 turn 内
 *       看到 usage 增长的入口；超过阈值直接入队 compaction。
 */
export async function maybeAutoCompressStep(input: {
  readonly ctx: Plugin.Context
  readonly sessionID: string
  readonly tokens: {
    readonly input: number
    readonly cache: { readonly read: number; readonly write: number }
  }
}): Promise<void> {
  try {
    // 插件按 location 各加载一份；只让 session 所属 location 处理，
    // 会话查不到（别的实例的会话）也拒绝，避免同一事件被多实例重复入队压缩。
    const session = await input.ctx.session.get({ sessionID: input.sessionID }).catch(() => undefined)
    if (session?.location.directory !== input.ctx.location.directory) return
    if (isCompactionInFlight(input.sessionID)) return
    const state = await expireStalePendingStorage(input.ctx, input.sessionID)
    if (blockedByState(state)) return

    const settings = resolveForModel(await loadServerSettings(input.ctx), session.model)
    if (!settings.autoCompress) return
    // step.ended 不带模型引用，用会话当前模型解析按模型设置；窗口仍取生效值缓存。
    // 原生窗口单独是 1M 时阈值会变成 800k，压缩永远不会触发。
    const effective = await effectiveLimit(input.ctx.storage, input.sessionID)
    if (effective === undefined || effective <= 0) return
    if (effective - SUMMARY_WINDOW_RESERVE < MIN_SUMMARY_BLOCK_CHARS) return

    if (state.phase !== undefined) {
      // 预算已经回落就不要再压：清掉 phase 后照常走阈值判断。
      if (summaryOverBudget(state, settings, effective)) {
        await requestCompaction(input.ctx, input.sessionID)
        return
      }
      await clearStalePhaseIfWithinBudget(input.ctx, input.sessionID, state, settings, effective)
    }

    const threshold = triggerTokens(settings, effective)
    if (threshold === undefined) return
    if (promptTokens(input.tokens) < threshold) return
    // 刚压缩完、还没有新的 user 消息时，历史里只剩 checkpoint；再入队只会得到
    // Nothing to compact yet，并在 state 里留下一次无意义的 attempts。
    if (!(await hasUserSinceCompaction(input.ctx, input.sessionID))) return

    // 入队后同步等压缩落地，对齐 OpenCode 原生压缩的语义：
    // 下一个 step 的模型请求一定从压缩后的上下文开始，而不是继续放大。
    await requestCompaction(input.ctx, input.sessionID, {
      blocks: state.blocks.length,
      lastError: state.lastError,
    })
  } catch (error) {
    await recordCompressionFailure(input.ctx, input.sessionID, error)
  }
}

/**
 * 输入：服务端上下文 + sessionID + 可选的压缩前快照。
 * 输出：是否真的发起了 compaction；被别的请求抢走发起权时为 false。
 * 预期：抢到发起权后入队一次 compact，finally 一定释放；给了 before 就等压缩落地。
 */
async function requestCompaction(
  ctx: Plugin.Context,
  sessionID: string,
  before?: { blocks: number; lastError: string | undefined },
): Promise<boolean> {
  if (!tryBeginCompactionRequest(sessionID)) return false
  try {
    await ctx.session.compact({ sessionID })
    if (before !== undefined) await waitForCompaction(ctx, sessionID, before)
    return true
  } finally {
    endCompactionRequest(sessionID)
  }
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

/** 输入：插件上下文 + 模型标识 + 窗口；输出：无；预期：写进 storage 供 TUI 读取，失败不影响压缩。 */
async function rememberWindow(
  ctx: Plugin.Context,
  providerID: string,
  modelID: string,
  limit: number,
  sessionID?: string,
): Promise<void> {
  try {
    // 模型原生窗口是模型属性，跨会话共享没有歧义。
    await ctx.storage.set(windowKey(providerID, modelID), limit)
    if (sessionID === undefined) {
      // 不知道会话时才写全局 last；多会话并行时全局值是最后写者赢，不能当会话数据用。
      await ctx.storage.set(RESOLVED_WINDOW_KEY, limit)
      return
    }
    await ctx.storage.set(resolvedWindowKey(sessionID), limit)
  } catch {
    // best effort：写不进去只影响 TUI 显示，不影响压缩
  }
}

/**
 * 输入：设置 + 模型；输出：实际使用的窗口大小。
 * 预期：数字设置是上限，先解析模型原生窗口再取 min；auto 直接用原生值。
 */
export async function resolveLimit(
  ctx: Plugin.Context,
  model: ModelRefLike,
  setting: "auto" | number,
  sessionID?: string,
): Promise<number | undefined> {
  const key = `${model.providerID}/${model.id}`
  const cached = limitCache.get(key)
  let native = cached !== undefined && Date.now() - cached.at < LIMIT_TTL ? cached.limit : undefined
  if (native === undefined) {
    try {
      const result = await ctx.model.list()
      const info = result.data.find((item) => item.providerID === model.providerID && item.id === model.id)
      const limit = info?.limit.context
      if (typeof limit === "number" && limit > 0) {
        native = limit
        limitCache.set(key, { at: Date.now(), limit })
        await rememberWindow(ctx, model.providerID, model.id, limit, sessionID)
      }
    } catch {
      // 原生窗口未知：数字设置按原值使用，auto 则关闭自动压缩
    }
  }
  const effective = setting === "auto" ? native : native === undefined ? setting : Math.min(setting, native)
  if (typeof effective === "number" && effective > 0) {
    try {
      if (sessionID === undefined) await ctx.storage.set(EFFECTIVE_WINDOW_KEY, effective)
      else await ctx.storage.set(effectiveWindowKey(sessionID), effective)
    } catch {
      // best effort：写不进去只影响 step.ended 兜底
    }
  }
  return effective
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

/** 单个 assistant 的真实 prompt 大小；output/reasoning 不属于本轮输入。 */
function promptTokens(tokens: {
  readonly input: number
  readonly cache: { readonly read: number; readonly write: number }
}): number {
  return tokens.input + tokens.cache.read + tokens.cache.write
}

/**
 * 输入：服务端上下文 + sessionID。
 * 输出：最后一个 assistant 的真实 prompt token；没有 usage 时 undefined。
 * 预期：SessionHistory 按 seq 升序返回，从末尾取最新 assistant。
 */
export async function measuredPromptTokens(
  ctx: Plugin.Context,
  sessionID: string,
): Promise<number | undefined> {
  try {
    const messages = await ctx.session.context({ sessionID })
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.type !== "assistant" || message.tokens === undefined) continue
      const total = promptTokens(message.tokens)
      if (total > 0) return total
    }
  } catch {
    // 没有 session.context 或 provider 没返回 usage：调用方回退到估算
  }
  return undefined
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

    const state = await expireStalePendingStorage(input.ctx, input.sessionID)
    if (blockedByState(state)) return

    const settings = resolveForModel(await loadServerSettings(input.ctx), input.model)
    if (!settings.autoCompress) return
    const limit = await resolveLimit(input.ctx, input.model, settings.contextLimit, input.sessionID)
    if (limit === undefined || limit <= 0) return
    // 窗口小到连最小摘要都放不下：压缩必然失败，别反复入队空压缩。
    if (limit - SUMMARY_WINDOW_RESERVE < MIN_SUMMARY_BLOCK_CHARS) return

    // 已排下一层蒸馏：只有摘要确实还超预算才入队；预算已回落就清掉 phase。
    // 不能在 T1 刚结束时入队——那时历史里只剩 checkpoint，OpenCode 会拒绝压缩。
    if (state.phase !== undefined) {
      if (summaryOverBudget(state, settings, limit)) {
        await requestCompaction(input.ctx, input.sessionID)
        return
      }
      await clearStalePhaseIfWithinBudget(input.ctx, input.sessionID, state, settings, limit)
    }

    const total = (await measuredPromptTokens(input.ctx, input.sessionID)) ?? estimateTotal(input)
    const threshold = triggerTokens(settings, limit)
    if (threshold === undefined || total < threshold) return
    const eligible = eligibleMessages(input.messages)
    const sourceChars = buildTranscript(eligible).length
    // 第一次触发要求有实质内容；失败过（attempts>0）就必须能重试，不能因为短就永远跳过。
    const retrying = state.attempts > 0 && state.lastError !== undefined
    if (eligible.length === 0) return
    if (!retrying && sourceChars < MIN_SOURCE_CHARS) return

    await requestCompaction(input.ctx, input.sessionID)
  } catch (error) {
    await recordCompressionFailure(input.ctx, input.sessionID, error)
  }
}

/** 输入：本次增长量 + 是否已有压缩块 + 自动压缩开关；输出：追加到请求尾部的提醒文本。 */
export function buildNudgeText(growthTokens: number, hasCompressed: boolean, autoCompress: boolean): string {
  const scope = hasCompressed ? "since the last compressed block" : "since the session started"
  const fallback = autoCompress
    ? "Automatic compression will run later, so there is no rush."
    : "Call compress when convenient."
  return (
    `[context-reminder] Context has grown by about ${formatTokens(growthTokens)} tokens ${scope}. ` +
    // 默认不压：任务没做完、或还需要这些精确细节时继续干活；只有到了自然的停顿点才压缩。
    "Do not compress yet if you are busy or if you still need these exact details: keep working and ignore this reminder. " +
    `When you reach a natural stopping point, you may call compress to checkpoint the entire current conversation flow ${scope}. ` +
    fallback
  )
}

/** 主动压缩提醒的输入；messages 必须可追加，和只读的自动压缩输入区分开。 */
export type NudgeInput = Omit<AutoInput, "messages"> & {
  readonly messages: MessageLike[]
}

/**
 * 输入：服务端上下文 + 可追加消息。
 * 输出：无。
 * 预期：按 nudgeGrowthTokens 增长量在请求尾部追加一次提醒；压缩中、终止、失败上限或
 *       没有可压缩内容时跳过。
 */
export async function maybeNudge(input: NudgeInput): Promise<void> {
  try {
    if (isCompactionInFlight(input.sessionID)) return
    if (isCompressionInstruction(input.messages)) return

    const settings = resolveForModel(await loadServerSettings(input.ctx), input.model)
    if (settings.nudgeGrowthTokens <= 0) return
    // compress 工具被关闭时提醒没有意义：模型即使看到也调不动。
    // 只跳过本次提醒，不改用户的 nudgeGrowthTokens / enableCompressTool 设置。
    if (!settings.enableCompressTool) return

    const total = (await measuredPromptTokens(input.ctx, input.sessionID)) ?? estimateTotal(input)
    // 没有可压缩内容时仍要建立基线；只是不追加提醒，也不推进基线。
    const eligible = eligibleMessages(input.messages)
    const canEmit = eligible.length > 0 && buildTranscript(eligible).length >= MIN_SOURCE_CHARS

    // 测量在锁外完成；基线比较和写入必须在同一事务里，否则并发请求会重复提醒。
    const notice = await stateStore(input.ctx.storage).transact(input.sessionID, (state) => {
      if (isCompactionInFlight(input.sessionID)) return { result: undefined }
      if (blockedByState(state) || state.phase !== undefined) return { result: undefined }

      if (state.nudgeBaselineTokens === undefined || state.nudgeBaselineTokens > total) {
        return { next: { ...state, nudgeBaselineTokens: total }, result: undefined }
      }
      const growth = total - state.nudgeBaselineTokens
      if (growth < settings.nudgeGrowthTokens) return { result: undefined }
      if (!canEmit) return { result: undefined }

      const hasCompressed = state.blocks.length > 0
      return {
        next: {
          ...state,
          nudgeBaselineTokens: total,
          nudgeCount: (state.nudgeCount ?? 0) + 1,
        },
        result: buildNudgeText(growth, hasCompressed, settings.autoCompress),
      }
    })
    if (notice === undefined) return

    input.messages.push({
      role: "user",
      content: [{ type: "text", text: notice }],
    })
    // 让 TUI 的消息流也能看到这次提醒；内容就是发给模型的那一条，不另写文案。
    // steer 让它在当前 step 结束后投递，resume:false 不会额外唤醒新一轮。
    try {
      await input.ctx.session.synthetic({
        sessionID: input.sessionID,
        text: notice,
        // description 就是 TUI 灰字展示的正文；和模型看到的 text 保持逐字一致，不做截断。
        description: notice,
        delivery: "steer",
        resume: false,
      })
    } catch {
      // best effort
    }
  } catch {
    // 提醒是 best effort，不能影响模型请求。
  }
}
