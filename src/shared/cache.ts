/**
 * 缓存命中历史的跨进程载体。
 *
 * 服务端插件在 session.idle 时把最近 10 条 assistant 消息的 usage 追加到
 * storage（`cache:history:<sessionID>`）；TUI 通过 RPC 读取。
 * 本模块只放纯函数：采样、追加、校验、排序，方便单测。
 */

/** 每个会话一份，key 里带 sessionID，父/子会话互不影响。 */
export const CACHE_HISTORY_PREFIX = "cache:history:"

/** 只保留最近 10 次请求。 */
export const CACHE_HISTORY_LIMIT = 10

/** 一条缓存命中样本；hitRate 是 0..100，向下截断到两位小数。 */
export interface CacheSample {
  readonly messageID: string
  readonly at: number
  readonly input: number
  readonly output: number
  readonly cached: number
  readonly hitRate: number
}

/** storage 里的持久化结构。 */
export interface CacheHistory {
  readonly v: 1
  readonly samples: readonly CacheSample[]
}

export const EMPTY_CACHE_HISTORY: CacheHistory = { v: 1, samples: [] }

/**
 * 输入：总输入 token + 命中 token。
 * 输出：0..100 的百分比，向下截断到两位小数。
 * 预期：不四舍五入；99.999% 显示 99.99，不会变成 100.00。
 */
export function hitRatePercent(input: number, cached: number): number {
  if (input <= 0) return 0
  return Math.floor(Math.min(1, cached / input) * 10_000) / 100
}

/** 输入：命中率；输出：固定两位小数的百分比文本（不含 `%`）。 */
export function formatHitRate(hitRate: number): string {
  return hitRate.toFixed(2)
}

/** 输入：sessionID；输出：该会话的 storage key。 */
export function cacheHistoryKey(sessionID: string): string {
  return CACHE_HISTORY_PREFIX + sessionID
}

/**
 * 输入：消息（结构最小化，便于测试替身）。
 * 输出：assistant 且带 tokens 时返回样本，否则 undefined。
 */
export interface CacheMessage {
  readonly id: string
  readonly type: string
  readonly time?: { readonly created?: number }
  readonly tokens?: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cache: { readonly read: number; readonly write: number }
  }
}

/** 输入：消息 + 缺时间时的回退值；输出：样本或 undefined。 */
export function sampleFromMessage(message: CacheMessage, fallbackAt: number): CacheSample | undefined {
  if (message.type !== "assistant") return undefined
  const tokens = message.tokens
  if (tokens === undefined) return undefined
  const input = tokens.input + tokens.cache.read + tokens.cache.write
  const output = tokens.output + tokens.reasoning
  const cached = tokens.cache.read
  return {
    messageID: message.id,
    at: message.time?.created ?? fallbackAt,
    input,
    output,
    cached,
    hitRate: hitRatePercent(input, cached),
  }
}

/** 输入：样本列表；输出：按时间升序、去重、只留最新 10 条。 */
function normalizeSamples(samples: readonly CacheSample[]): readonly CacheSample[] {
  const unique = new Map<string, CacheSample>()
  for (const sample of samples) {
    // 同一条消息重复出现时保留第一次记录，避免重试把同一条刷成多条。
    if (!unique.has(sample.messageID)) unique.set(sample.messageID, sample)
  }
  return [...unique.values()]
    .sort((left, right) => left.at - right.at || left.messageID.localeCompare(right.messageID))
    .slice(-CACHE_HISTORY_LIMIT)
}

/**
 * 输入：已有历史 + 当前可见消息。
 * 输出：追加未记录过的 assistant 样本后的新历史。
 * 预期：按 messageID 去重；按时间排序；只保留最新 10 条。
 */
export function appendCacheSamples(
  existing: readonly CacheSample[],
  messages: readonly CacheMessage[],
  now: number = Date.now(),
): readonly CacheSample[] {
  const known = new Set(existing.map((sample) => sample.messageID))
  const added: CacheSample[] = []
  for (const message of messages) {
    if (known.has(message.id)) continue
    const sample = sampleFromMessage(message, now)
    if (sample === undefined) continue
    known.add(sample.messageID)
    added.push(sample)
  }
  return normalizeSamples([...existing, ...added])
}

/**
 * 输入：已有历史 + 单个 step 的 assistant usage。
 * 输出：追加该 step 样本后的新历史。
 * 预期：tool loop 里 context/usage.updated 拿不到最新 step usage，
 *       `session.step.ended` 事件直接携带 tokens，这里按 messageID 去重落一条。
 */
export function appendCacheSampleFromStep(
  existing: readonly CacheSample[],
  messageID: string,
  tokens: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cache: { readonly read: number; readonly write: number }
  },
  fallbackAt: number = Date.now(),
): readonly CacheSample[] {
  return appendCacheSamples(existing, [{ id: messageID, type: "assistant", tokens }], fallbackAt)
}

/** 输入：任意 storage 值；输出：合法历史；损坏时返回空历史，绝不抛错。hitRate 按 input/cached 重算。 */
export function parseCacheHistory(value: unknown): CacheHistory {
  if (typeof value !== "object" || value === null) return EMPTY_CACHE_HISTORY
  const record = value as Record<string, unknown>
  if (record["v"] !== 1 || !Array.isArray(record["samples"])) return EMPTY_CACHE_HISTORY
  const samples: CacheSample[] = []
  for (const item of record["samples"]) {
    if (typeof item !== "object" || item === null) continue
    const sample = item as Record<string, unknown>
    const messageID = sample["messageID"]
    const at = sample["at"]
    const input = sample["input"]
    const output = sample["output"]
    const cached = sample["cached"]
    if (typeof messageID !== "string" || messageID.length === 0) continue
    if (
      typeof at !== "number" ||
      !Number.isFinite(at) ||
      at < 0 ||
      typeof input !== "number" ||
      !Number.isFinite(input) ||
      input < 0 ||
      typeof output !== "number" ||
      !Number.isFinite(output) ||
      output < 0 ||
      typeof cached !== "number" ||
      !Number.isFinite(cached) ||
      cached < 0
    ) {
      continue
    }
    samples.push({
      messageID,
      at,
      input,
      output,
      cached,
      hitRate: hitRatePercent(input, cached),
    })
  }
  return { v: 1, samples: normalizeSamples(samples) }
}

/** 输入：两条历史；输出：样本是否完全一致；用于避免无变化的重复写盘。 */
export function cacheHistoryEquals(left: readonly CacheSample[], right: readonly CacheSample[]): boolean {
  if (left.length !== right.length) return false
  return left.every((sample, index) => {
    const other = right[index]
    if (other === undefined) return false
    return (
      sample.messageID === other.messageID &&
      sample.at === other.at &&
      sample.input === other.input &&
      sample.output === other.output &&
      sample.cached === other.cached &&
      sample.hitRate === other.hitRate
    )
  })
}
