import type { Plugin } from "@opencode/plugin"

import { formatTokens } from "../shared/format.ts"
import { resolveForModel, resolveSummaryLimits, triggerTokens } from "../shared/settings.ts"
import { countText, estimateCategories, totalCategories, type ToolDefinitionLike } from "../shared/tokens.ts"
import { endCompactionRequest, isCompactionInFlight, tryBeginCompactionRequest } from "./inflight.ts"
import { pickMergeGroup } from "./distill.ts"
import { activeBlocks, renderAll } from "./render.ts"
import { eligibleMessages, type MessageLike } from "./select.ts"
import { isSubagentSession } from "./session-role.ts"
import {
  EFFECTIVE_WINDOW_KEY,
  RESOLVED_WINDOW_KEY,
  effectiveWindowKey,
  loadServerSettings,
  resolvedWindowKey,
  windowKey,
} from "./settings.ts"
import {
  MAX_DISTILL_ROUNDS,
  PENDING_TIMEOUT_MS,
  clearPhase,
  expireStalePending,
  loadState,
  type State,
} from "./state.ts"
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

/** 窗口小于这个值时不判摘要预算：`physical = window - reserve` 会退化成 0/1，压不进去也判不准。 */
const MIN_SUMMARY_WINDOW_TOKENS = 10_000

/**
 * 输入：服务端上下文 + sessionID + 入队前的 state 快照。
 * 输出：无。
 * 预期：阻塞直到该次 compaction 落地——blocks 增多、lastError 出现或变化、或等待超时。
 *       超时不抛错，放行请求；失败由调用方的 catch 记进 lastError。
 */
export async function waitForCompaction(
  ctx: Plugin.Context,
  sessionID: string,
  before: { blocks: number; lastError: string | undefined },
): Promise<void> {
  const started = Date.now()
  const deadline = started + COMPACTION_WAIT_MS
  let pendingSince: number | undefined
  let sawInFlight = false
  while (Date.now() < deadline) {
    const state = await loadState(ctx.storage, sessionID)
    const settled = state.blocks.length > before.blocks
    const failed = state.lastError !== undefined && state.lastError !== before.lastError
    if (settled || failed) {
      // 钩子的 finally 可能还没清 in-flight；等它清掉再放行。
      while (isCompactionInFlight(sessionID) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, COMPACTION_POLL_MS))
      }
      return
    }
    if (isCompactionInFlight(sessionID)) {
      sawInFlight = true
    } else if (!sawInFlight && Date.now() - started > COMPACTION_POLL_MS * 3) {
      // 钩子从头到尾没接手（宿主拒绝空压缩、别的实例已处理）：立刻放行，
      // 否则会占着发起权、并把该会话的事件队列串行阻塞 5 分钟。
      return
    }
    if (state.pending !== undefined) {
      pendingSince ??= Date.now()
      if (Date.now() - pendingSince > COMPACTION_COMMIT_WAIT_MS) return
    }
    await new Promise((resolve) => setTimeout(resolve, COMPACTION_POLL_MS))
  }
}

/**
 * 输入：storage + sessionID。
 * 输出：最近一次解析到的「生效窗口」；没有则 undefined。
 * 预期：`resolveLimit` 把 min(设置, 原生) 写进会话级键，这里只读结果。
 */
async function effectiveLimit(
  storage: Plugin.Context["storage"],
  sessionID: string,
): Promise<number | undefined> {
  const scoped = await storage.get(effectiveWindowKey(sessionID))
  if (typeof scoped === "number" && scoped > 0) return scoped
  const stored = await storage.get(EFFECTIVE_WINDOW_KEY)
  return typeof stored === "number" && stored > 0 ? stored : undefined
}

/**
 * 输入：会话状态。
 * 输出：本轮是否必须跳过。
 * 预期：只有「已经有一刀在路上」才跳过。失败次数不关闭自动压缩——和 OpenCode 自身一致，
 *       下一次请求用量仍在阈值上就自然再触发一次。
 */
function blockedByState(state: State): boolean {
  if (state.pending !== undefined) {
    const marked = state.pendingAt
    return marked === undefined || Date.now() - marked < PENDING_TIMEOUT_MS
  }
  return false
}

/**
 * 输入：会话状态 + 合并后的设置 + 生效窗口。
 * 输出：摘要链是否超过 token 预算。
 * 预期：只按 countText 判断；窗口未知时无法比较，直接返回 false。
 */
function summaryOverBudget(
  state: State,
  settings: ReturnType<typeof resolveForModel>,
  windowTokens: number | undefined,
): boolean {
  if (windowTokens === undefined) return false
  const limits = resolveSummaryLimits(settings, windowTokens)
  // 窗口本身小于预留区时预算没有意义（budget 会退化成 1），继续入队只会每轮白压 8 刀。
  if (windowTokens <= MIN_SUMMARY_WINDOW_TOKENS) return false
  const summary = renderAll(state.blocks, state.pending, {
    showTimeline: settings.showTimeline,
    showBlockTokens: settings.showBlockTokens,
  })
  return countText(summary) > limits.budgetTokens
}

/**
 * 输入：状态 + 保留区设置。
 * 输出：是否还有可合并的块。
 * 预期：判定必须与 distillOnce 选组逻辑同源（pickMergeGroup），否则会出现
 *       「闸门说不能合、压缩钩子其实能合」导致超预算摘要一直卡住。
 *       单块也能自压一层，所以这里不要求必须凑出两块。
 */
function mergePossible(state: State, recentT1Blocks: number): boolean {
  return pickMergeGroup(activeBlocks(state.blocks, state.pending), recentT1Blocks) !== undefined
}

/**
 * 输入：插件上下文 + sessionID。
 * 输出：phase 为空时补上「下一层 = 2」；已有 pending 或已有 phase 时不动。
 * 预期：摘要已经超预算但 phase 丢了（压缩钩子被跳过、或上一层收尾没排上）时用，
 *       保证下一次压缩走合并分支而不是重复 T1。pending 在场时不能插手：
 *       那是手动 compress 刚写进去的 T1，会被误当成待合并块。
 */
async function armMergePhase(ctx: Plugin.Context, sessionID: string): Promise<void> {
  await stateStore(ctx.storage).transact(sessionID, (current) =>
    current.phase !== undefined || current.pending !== undefined
      ? { result: undefined }
      : { next: { ...current, phase: 2 }, result: undefined },
  )
}

/**
 * 输入：插件上下文 + sessionID + 状态 + 设置 + 窗口。
 * 输出：无。
 * 预期：摘要回到预算内时清掉残留的 phase，避免每个请求都入队一次压缩。
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
 * 输入：插件上下文 + sessionID。
 * 输出：最近一次 completed compaction 之后是否出现了新的 user 消息。
 * 预期：没有 compaction 或读不到历史时返回 true；读不到时宁可放行，由钩子给出真实错误。
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
    return messages.slice(latest + 1).some((message) => {
      if (message.type !== "user") return false
      return messageTextOf(message).trim().length > 0
    })
  } catch {
    return true
  }
}

/**
 * 输入：一条 session 消息。
 * 输出：它的正文。
 * 预期：不同版本把正文放在 `text` 或 `content[].text`，两种都要认；都没有就返回空串，
 *       不能抛错——抛错会被外层 catch 当成「读不到历史」而永远放行。
 */
function messageTextOf(message: unknown): string {
  if (typeof message !== "object" || message === null) return ""
  const record = message as Record<string, unknown>
  const direct = record["text"]
  if (typeof direct === "string") return direct
  const content = record["content"]
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (typeof part !== "object" || part === null) return ""
      const text = (part as Record<string, unknown>)["text"]
      return typeof text === "string" ? text : ""
    })
    .join("")
}

/**
 * 输入：插件上下文 + sessionID。
 * 输出：过期兜底后的最新状态。
 * 预期：pending 挂起超过 PENDING_TIMEOUT_MS 时强制转正写回；其余原样读。
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
 * 输入：插件上下文 + sessionID + 捕获到的错误。
 * 输出：无。
 * 预期：只记录 lastError，不计数、不关闭自动压缩；写状态失败时忽略，避免掩盖原始错误。
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
      next: { ...current, lastError: String(error) },
      result: undefined,
    }))
  } catch {
    // best effort
  }
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
    await ctx.storage.set(windowKey(providerID, modelID), limit)
    if (sessionID === undefined) {
      await ctx.storage.set(RESOLVED_WINDOW_KEY, limit)
      return
    }
    await ctx.storage.set(resolvedWindowKey(sessionID), limit)
  } catch {
    // best effort：写不进去只影响 TUI 显示
  }
}

/**
 * 输入：设置 + 模型；输出：实际使用的窗口大小。
 * 预期：数字设置是上限，取 min(设置, 原生)；auto 直接用原生值。
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
      // 原生窗口解析失败：数字设置仍可单独使用
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
 * 预期：从历史末尾取最新 assistant。
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

export interface AutoInput {
  readonly ctx: Plugin.Context
  readonly sessionID: string
  readonly messages: readonly MessageLike[]
  readonly system: readonly { readonly type: string; readonly text: string }[]
  readonly tools: Readonly<Record<string, ToolDefinitionLike>>
  readonly model: ModelRefLike
}

/**
 * 输入：服务端上下文 + sessionID + 可选压缩前快照。
 * 输出：是否真的发起了 compaction。
 * 预期：抢到发起权才入队；失败原样抛给调用方记录，finally 一定释放发起权。
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
 * 输入：服务端上下文 + 当前请求。
 * 输出：无。
 * 预期：只有两件事——已开头的合并链继续跑；开了自动压缩且用量过线时入队。
 *       失败只记 lastError，不关闭自动压缩。
 */
export async function maybeAutoCompress(input: AutoInput): Promise<void> {
  try {
    // 插件按 location 各加载一份：只让会话所属 location 处理，否则会用错项目的设置压别人的会话。
    const session = await input.ctx.session.get({ sessionID: input.sessionID }).catch(() => undefined)
    if (session?.location.directory !== input.ctx.location.directory) return
    if (isCompactionInFlight(input.sessionID)) return

    const state = await expireStalePendingStorage(input.ctx, input.sessionID)
    if (blockedByState(state)) return
    const settings = resolveForModel(await loadServerSettings(input.ctx), input.model)
    const limit =
      (await resolveLimit(input.ctx, input.model, settings.contextLimit, input.sessionID)) ??
      (await effectiveLimit(input.ctx.storage, input.sessionID))

    // 已开头的合并链：与 autoCompress 无关，手动压缩后也要继续 T2/T3。
    // 但要等新的 user 消息：刚压完就再请求一刀，宿主会回「没有可压缩内容」并留下一条虚假失败。
    if (state.phase !== undefined) {
      if (
        summaryOverBudget(state, settings, limit) &&
        (await hasUserSinceCompaction(input.ctx, input.sessionID))
      ) {
        await requestCompaction(input.ctx, input.sessionID)
      } else if (!summaryOverBudget(state, settings, limit)) {
        await clearStalePhaseIfWithinBudget(input.ctx, input.sessionID, state, settings, limit)
      }
      return
    }

    // 自动触发：只看开关和用量。
    if (!settings.autoCompress) return
    // 摘要自己撑爆预算也要合并：与上下文占用无关。否则手动压完就超预算、phase 又丢了时，
    // 要等到下一次用量过线才会再压一刀，中间一直卡着超预算的摘要。
    // 必须等新的 user 消息：压完立刻再请求一刀只会得到宿主的「没有可压缩内容」。
    if (
      summaryOverBudget(state, settings, limit) &&
      mergePossible(state, settings.recentT1Blocks) &&
      (state.distillRounds ?? 0) < MAX_DISTILL_ROUNDS &&
      (await hasUserSinceCompaction(input.ctx, input.sessionID))
    ) {
      await armMergePhase(input.ctx, input.sessionID)
      await requestCompaction(input.ctx, input.sessionID)
      return
    }
    if (limit === undefined) return
    const total = (await measuredPromptTokens(input.ctx, input.sessionID)) ?? estimateTotal(input)
    const threshold = triggerTokens(settings, limit)
    if (threshold === undefined || total < threshold) return
    // 一次用户消息最多自动压一刀：刚压完还没有新的 user 消息时，再压只会把只剩 checkpoint 的
    // 历史重压一遍；这也是 patch 掉「同一轮里反复入队」的唯一确定性判据（不能靠 pending 的时序）。
    if (!(await hasUserSinceCompaction(input.ctx, input.sessionID))) return
    const eligible = eligibleMessages(input.messages)
    if (eligible.length === 0) return
    if (buildTranscript(eligible).length < MIN_SOURCE_CHARS) return

    await requestCompaction(input.ctx, input.sessionID)
  } catch (error) {
    await recordCompressionFailure(input.ctx, input.sessionID, error)
  }
}

/**
 * 输入：`session.step.ended` 事件带的 usage + 服务端上下文 + sessionID。
 * 输出：无。
 * 预期：tool loop 的后续 step 不触发 context 钩子，这里是同 turn 内看到 usage 增长的入口。
 *       规则与 context 路径完全一致，只是用量来自事件。
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
    // 插件按 location 各加载一份；只让 session 所属 location 处理。
    const session = await input.ctx.session.get({ sessionID: input.sessionID }).catch(() => undefined)
    if (session?.location.directory !== input.ctx.location.directory) return
    if (isCompactionInFlight(input.sessionID)) return
    const state = await expireStalePendingStorage(input.ctx, input.sessionID)
    if (blockedByState(state)) return

    const settings = resolveForModel(await loadServerSettings(input.ctx), session.model)
    const effective = await effectiveLimit(input.ctx.storage, input.sessionID)

    // 已开头的合并链：与 autoCompress 无关；同样要求有新的 user 消息。
    if (state.phase !== undefined) {
      if (
        summaryOverBudget(state, settings, effective) &&
        (await hasUserSinceCompaction(input.ctx, input.sessionID))
      ) {
        await requestCompaction(input.ctx, input.sessionID)
      } else if (!summaryOverBudget(state, settings, effective)) {
        await clearStalePhaseIfWithinBudget(input.ctx, input.sessionID, state, settings, effective)
      }
      return
    }

    if (!settings.autoCompress) return
    // 与 context 路径同理：摘要超预算就合并，不等用量过线；同样要求有新的 user 消息。
    if (
      summaryOverBudget(state, settings, effective) &&
      mergePossible(state, settings.recentT1Blocks) &&
      (state.distillRounds ?? 0) < MAX_DISTILL_ROUNDS &&
      (await hasUserSinceCompaction(input.ctx, input.sessionID))
    ) {
      await armMergePhase(input.ctx, input.sessionID)
      await requestCompaction(input.ctx, input.sessionID)
      return
    }
    const threshold = triggerTokens(settings, effective)
    if (threshold === undefined || promptTokens(input.tokens) < threshold) return
    // 刚压缩完、还没有新的 user 消息时，历史里只剩 checkpoint，入队只会得到空压缩。
    if (!(await hasUserSinceCompaction(input.ctx, input.sessionID))) return

    // 入队后同步等压缩落地，对齐 OpenCode 原生压缩的语义。
    await requestCompaction(input.ctx, input.sessionID, {
      blocks: state.blocks.length,
      lastError: state.lastError,
    })
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
 * 预期：按 nudgeGrowthTokens 增长量在请求尾部追加一次提醒；压缩中、有 pending、或没有可压缩内容时跳过。
 */
export async function maybeNudge(input: NudgeInput): Promise<void> {
  try {
    if (isCompactionInFlight(input.sessionID)) return
    // 子代理会话短命：提醒它去考虑压缩纯属打扰。
    if (await isSubagentSession(input.ctx, input.sessionID)) return

    const settings = resolveForModel(await loadServerSettings(input.ctx), input.model)
    if (settings.nudgeGrowthTokens <= 0) return
    // compress 工具被关闭时提醒没有意义：模型即使看到也调不动。
    if (!settings.enableCompressTool) return

    const total = (await measuredPromptTokens(input.ctx, input.sessionID)) ?? estimateTotal(input)
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
    // 让 TUI 的消息流也能看到这次提醒；description 与发给模型的 text 逐字一致。
    try {
      await input.ctx.session.synthetic({
        sessionID: input.sessionID,
        text: notice,
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
