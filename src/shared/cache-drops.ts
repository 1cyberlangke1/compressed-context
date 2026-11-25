/**
 * 缓存突变的跨进程载体与纯逻辑。
 *
 * 服务端在 `http.request` 抓下发给上游的原始请求体，在该请求的 usage 已知后
 * 与上一条样本比较：命中率跌幅达到阈值时，记录断点所在段、段内偏移、两侧原文、
 * 请求结构轮廓与断点段的原始文本。本模块只放纯函数：切段、找首个差异、摘录、
 * 解析、裁剪，方便单测。
 */

/** 触发这次请求的用途；与宿主的 `SessionRequestKind` 对齐。 */
export type CacheRequestKind = "primary" | "compaction" | "title" | "generate" | "unknown"

/** 断点归类；`append`/`none` 表示前缀没有变，掉缓存与本地报文无关。 */
export type CacheDropCause =
  | "system"
  | "tools"
  | "params"
  | "history"
  | "window"
  | "append"
  | "none"
  | "unknown"

/** 首个差异的位置与两侧原文。 */
export interface CacheDropBreak {
  /** 段标识，如 `system[0]` / `tools[2]` / `messages[7]` / `options`。 */
  readonly segment: string
  /** 段内字符偏移（按 Unicode 码点计）。 */
  readonly offset: number
  /** 上一轮断点附近的原文。 */
  readonly before: string
  /** 这一轮断点附近的原文。 */
  readonly after: string
}

/** 请求结构里的一段；只存标识与字符数，便于在面板里展示「原始请求」的骨架。 */
export interface CacheDropSegment {
  readonly key: string
  readonly chars: number
}

/** 断点所在段的原始文本；超出上限时截断并标记。 */
export interface CacheDropRequest {
  readonly segment: string
  readonly text: string
  readonly truncated: boolean
}

/** 一条缓存突变记录；只存诊断结果，不存整段 payload。 */
export interface CacheDrop {
  /** 本条样本 ID；primary 是 assistant messageID，其它请求是 `kind:时间`。 */
  readonly messageID: string
  readonly at: number
  /** 请求用途；旧记录没有这个字段。 */
  readonly kind?: CacheRequestKind
  readonly model?: string
  readonly prevMessageID: string
  readonly prompt: number
  readonly hit: number
  readonly hitRate: number
  readonly prevPrompt: number
  readonly prevHit: number
  readonly prevHitRate: number
  /** 命中率跌幅，单位是百分点。 */
  readonly dropPp: number
  readonly cause: CacheDropCause
  readonly breakPoint?: CacheDropBreak
  /** 当前请求的结构轮廓。 */
  readonly outline?: readonly CacheDropSegment[]
  /** 断点段的原始文本（截断）。 */
  readonly request?: CacheDropRequest
}

/** 按上游顺序分组的段：system → tools → messages → options。 */
interface Groups {
  readonly system: readonly string[]
  readonly tools: readonly string[]
  readonly messages: readonly string[]
  /** 其余顶层参数（model/temperature/stream…）的规范字符串。 */
  readonly options?: string
}

/** 一次请求差异的完整结果。 */
export interface RequestDiff {
  readonly cause: CacheDropCause
  readonly breakPoint?: CacheDropBreak
  /** 当前请求的段轮廓；解析失败时为空数组。 */
  readonly outline: readonly CacheDropSegment[]
  /** 断点段原文；没有断点时缺省。 */
  readonly request?: CacheDropRequest
}

/** 摘录在断点前保留的码点数。 */
const EXCERPT_LEAD = 40
/** 摘录总长（码点）。 */
const EXCERPT_LENGTH = 96
/** 原始请求片段最多存这么多码点，避免 100 条记录撑爆 storage。 */
export const REQUEST_TEXT_MAX_CHARS = 2_400

const SYSTEM_KEYS = ["system", "instructions", "systemInstruction"] as const
const MESSAGE_KEYS = ["messages", "input", "contents"] as const

/**
 * 输入：任意 JSON 值。
 * 输出：键按字典序排列的规范字符串。
 * 预期：同一对象不同键顺序得到同一字符串，避免把序列化差异误判成前缀断点。
 */
function canonicalJson(value: unknown): string {
  if (value === undefined) return "null"
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`
}

/** 输入：单段或数组；输出：逐元素规范字符串。 */
function itemsOf(value: unknown): readonly string[] {
  if (value === undefined) return []
  if (Array.isArray(value)) return value.map(canonicalJson)
  return [canonicalJson(value)]
}

/**
 * 输入：原始请求体。
 * 输出：按上游实际顺序分好的组；不是 JSON 对象时返回 undefined。
 * 预期：兼容 Chat Completions / Responses / Anthropic / Gemini 四种顶层字段。
 */
function groupsOf(body: string): Groups | undefined {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const system = SYSTEM_KEYS.map((key) => record[key]).find((item) => item !== undefined)
  const messages = MESSAGE_KEYS.map((key) => record[key]).find((item) => item !== undefined)
  const used = new Set<string>([...SYSTEM_KEYS, ...MESSAGE_KEYS, "tools"])
  const rest: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(record)) {
    if (used.has(key)) continue
    rest[key] = item
  }
  return {
    system: itemsOf(system),
    tools: itemsOf(record["tools"]),
    messages: itemsOf(messages),
    ...(Object.keys(rest).length === 0 ? {} : { options: canonicalJson(rest) }),
  }
}

/** 输入：分组；输出：请求结构轮廓（段标识 + 字符数）。 */
function outlineOf(groups: Groups): readonly CacheDropSegment[] {
  const segments: CacheDropSegment[] = []
  groups.system.forEach((text, index) => {
    segments.push({ key: `system[${index.toString()}]`, chars: Array.from(text).length })
  })
  groups.tools.forEach((text, index) => {
    segments.push({ key: `tools[${index.toString()}]`, chars: Array.from(text).length })
  })
  groups.messages.forEach((text, index) => {
    segments.push({ key: `messages[${index.toString()}]`, chars: Array.from(text).length })
  })
  if (groups.options !== undefined) {
    segments.push({ key: "options", chars: Array.from(groups.options).length })
  }
  return segments
}

/** 输入：段标识 + 原文；输出：截断后的原始请求片段。 */
function requestOf(segment: string, text: string): CacheDropRequest {
  const points = Array.from(text)
  return {
    segment,
    text: points.slice(0, REQUEST_TEXT_MAX_CHARS).join(""),
    truncated: points.length > REQUEST_TEXT_MAX_CHARS,
  }
}

/** 输入：原始请求体；输出：请求结构轮廓；解析失败时为空数组。 */
export function outlineFromBody(body: string): readonly CacheDropSegment[] {
  const groups = groupsOf(body)
  return groups === undefined ? [] : outlineOf(groups)
}

/** 输入：整段原始请求；输出：可直接展示的请求片段；用于没有断点的 unknown 记录。 */
export function requestPreview(body: string, segment = "request"): CacheDropRequest {
  return requestOf(segment, body)
}

/** 输入：两段已按码点拆开的文本；输出：首个不同码点的下标，完全相同返回较短长度。 */
function firstDifference(left: readonly string[], right: readonly string[]): number {
  const limit = Math.min(left.length, right.length)
  for (let index = 0; index < limit; index += 1) {
    if (left[index] !== right[index]) return index
  }
  return limit
}

/** 输入：段标识 + 两侧原文 + 偏移；输出：断点前后等长摘录。 */
function excerptOf(segment: string, prevText: string, nextText: string, offset: number): CacheDropBreak {
  const left = Array.from(prevText)
  const right = Array.from(nextText)
  const start = Math.max(0, offset - EXCERPT_LEAD)
  return {
    segment,
    offset,
    before: left.slice(start, start + EXCERPT_LENGTH).join(""),
    after: right.slice(start, start + EXCERPT_LENGTH).join(""),
  }
}

/** 输入：两侧同一位置的段列表；输出：该组是否变化及断点。 */
function diffGroup(
  prev: readonly string[],
  next: readonly string[],
  kind: "system" | "tools",
): { readonly breakPoint: CacheDropBreak; readonly text: string } | undefined {
  const limit = Math.min(prev.length, next.length)
  for (let index = 0; index < limit; index += 1) {
    const left = prev[index]
    const right = next[index]
    if (left === undefined || right === undefined || left === right) continue
    return {
      breakPoint: excerptOf(`${kind}[${index.toString()}]`, left, right, firstDifference(Array.from(left), Array.from(right))),
      text: right,
    }
  }
  if (prev.length === next.length) return undefined
  const index = limit
  const left = prev[index]
  const right = next[index]
  if (left !== undefined) {
    return {
      breakPoint: {
        segment: `${kind}[${index.toString()}]`,
        offset: 0,
        before: Array.from(left).slice(0, EXCERPT_LENGTH).join(""),
        after: "",
      },
      text: left,
    }
  }
  if (right !== undefined) {
    return {
      breakPoint: {
        segment: `${kind}[${index.toString()}]`,
        offset: 0,
        before: "",
        after: Array.from(right).slice(0, EXCERPT_LENGTH).join(""),
      },
      text: right,
    }
  }
  return undefined
}

/**
 * 输入：上一轮与这一轮的原始请求体。
 * 输出：首个差异归类、断点摘录、当前请求轮廓与断点段原文。
 * 预期：只在消息组判断窗口后移；解析失败时不声称有断点。
 */
export function diffRequests(prevBody: string, nextBody: string): RequestDiff {
  const prev = groupsOf(prevBody)
  const next = groupsOf(nextBody)
  if (prev === undefined || next === undefined) return { cause: "none", outline: [] }
  const outline = outlineOf(next)

  const system = diffGroup(prev.system, next.system, "system")
  if (system !== undefined) {
    return {
      cause: "system",
      breakPoint: system.breakPoint,
      outline,
      request: requestOf(system.breakPoint.segment, system.text),
    }
  }

  const tools = diffGroup(prev.tools, next.tools, "tools")
  if (tools !== undefined) {
    return {
      cause: "tools",
      breakPoint: tools.breakPoint,
      outline,
      request: requestOf(tools.breakPoint.segment, tools.text),
    }
  }

  const windowShift = isWindowShift(prev.messages, next.messages)
  const limit = Math.min(prev.messages.length, next.messages.length)
  for (let index = 0; index < limit; index += 1) {
    const left = prev.messages[index]
    const right = next.messages[index]
    if (left === undefined || right === undefined || left === right) continue
    const segment = `messages[${index.toString()}]`
    return {
      cause: windowShift ? "window" : "history",
      breakPoint: excerptOf(segment, left, right, firstDifference(Array.from(left), Array.from(right))),
      outline,
      request: requestOf(segment, right),
    }
  }

  if (prev.messages.length < next.messages.length) return { cause: "append", outline }
  if (prev.messages.length > next.messages.length) {
    const index = next.messages.length
    const removed = prev.messages[index]
    if (removed === undefined) return { cause: "history", outline }
    const segment = `messages[${index.toString()}]`
    return {
      cause: "history",
      breakPoint: {
        segment,
        offset: 0,
        before: Array.from(removed).slice(0, EXCERPT_LENGTH).join(""),
        after: "",
      },
      outline,
      request: requestOf(segment, removed),
    }
  }

  if (prev.options !== next.options) {
    const before = prev.options ?? ""
    const after = next.options ?? ""
    return {
      cause: "params",
      breakPoint: excerptOf("options", before, after, firstDifference(Array.from(before), Array.from(after))),
      outline,
      request: requestOf("options", after),
    }
  }
  return { cause: "none", outline }
}

/** 输入：两轮消息组；输出：这一轮的首条消息是否是上一轮更靠后的某条（窗口后移）。 */
function isWindowShift(prev: readonly string[], next: readonly string[]): boolean {
  const first = next[0]
  if (first === undefined) return false
  return prev.findIndex((item) => item === first) > 0
}

/** 输入：上一轮与这一轮的命中率（0..100）；输出：跌幅（百分点），保留两位小数。 */
export function dropPercent(prevHitRate: number, hitRate: number): number {
  return Math.round((prevHitRate - hitRate) * 100) / 100
}

/** 输入：任意 storage 值 + 上限；输出：合法记录，非法条目直接丢弃。 */
export function parseCacheDrops(value: unknown, maxRecords: number): readonly CacheDrop[] {
  if (!Array.isArray(value)) return []
  const drops: CacheDrop[] = []
  for (const item of value) {
    const drop = parseCacheDrop(item)
    if (drop !== undefined) drops.push(drop)
  }
  return drops.slice(-Math.max(1, maxRecords))
}

/** 输入：单条原始记录；输出：合法记录或 undefined。 */
function parseCacheDrop(value: unknown): CacheDrop | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const numbers = ["at", "prompt", "hit", "hitRate", "prevPrompt", "prevHit", "prevHitRate", "dropPp"] as const
  for (const key of numbers) {
    const item = record[key]
    if (typeof item !== "number" || !Number.isFinite(item) || item < 0) return undefined
  }
  const messageID = record["messageID"]
  const prevMessageID = record["prevMessageID"]
  const cause = record["cause"]
  if (typeof messageID !== "string" || messageID.length === 0) return undefined
  if (typeof prevMessageID !== "string" || prevMessageID.length === 0) return undefined
  if (!isCause(cause)) return undefined
  const kind = parseKind(record["kind"])
  const model = record["model"]
  const breakPoint = parseBreak(record["breakPoint"])
  const outline = parseOutline(record["outline"])
  const request = parseRequest(record["request"])
  return {
    messageID,
    at: record["at"] as number,
    ...(kind === undefined ? {} : { kind }),
    ...(typeof model === "string" && model.length > 0 ? { model } : {}),
    prevMessageID,
    prompt: record["prompt"] as number,
    hit: record["hit"] as number,
    hitRate: record["hitRate"] as number,
    prevPrompt: record["prevPrompt"] as number,
    prevHit: record["prevHit"] as number,
    prevHitRate: record["prevHitRate"] as number,
    dropPp: record["dropPp"] as number,
    cause,
    ...(breakPoint === undefined ? {} : { breakPoint }),
    ...(outline === undefined ? {} : { outline }),
    ...(request === undefined ? {} : { request }),
  }
}

/** 输入：任意值；输出：合法归类。 */
function isCause(value: unknown): value is CacheDropCause {
  return (
    value === "system" ||
    value === "tools" ||
    value === "params" ||
    value === "history" ||
    value === "window" ||
    value === "append" ||
    value === "none" ||
    value === "unknown"
  )
}

/** 输入：任意值；输出：合法请求类型或 undefined。 */
function parseKind(value: unknown): CacheRequestKind | undefined {
  return value === "primary" ||
    value === "compaction" ||
    value === "title" ||
    value === "generate" ||
    value === "unknown"
    ? value
    : undefined
}

/** 输入：任意值；输出：合法断点或 undefined。 */
function parseBreak(value: unknown): CacheDropBreak | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const segment = record["segment"]
  const offset = record["offset"]
  const before = record["before"]
  const after = record["after"]
  if (typeof segment !== "string" || segment.length === 0) return undefined
  if (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0) return undefined
  if (typeof before !== "string" || typeof after !== "string") return undefined
  return { segment, offset, before, after }
}

/** 输入：任意值；输出：合法轮廓或 undefined；空数组视为缺省。 */
function parseOutline(value: unknown): readonly CacheDropSegment[] | undefined {
  if (!Array.isArray(value)) return undefined
  const segments: CacheDropSegment[] = []
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue
    const record = item as Record<string, unknown>
    const key = record["key"]
    const chars = record["chars"]
    if (typeof key !== "string" || key.length === 0) continue
    if (typeof chars !== "number" || !Number.isFinite(chars) || chars < 0) continue
    segments.push({ key, chars })
  }
  return segments.length === 0 ? undefined : segments
}

/** 输入：任意值；输出：合法原始请求片段或 undefined。 */
function parseRequest(value: unknown): CacheDropRequest | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const segment = record["segment"]
  const text = record["text"]
  const truncated = record["truncated"]
  if (typeof segment !== "string" || segment.length === 0) return undefined
  if (typeof text !== "string") return undefined
  if (typeof truncated !== "boolean") return undefined
  return { segment, text, truncated }
}

/**
 * 输入：已有记录 + 新记录 + 上限。
 * 输出：按时间升序、按 messageID 去重、只留最新 maxRecords 条。
 * 预期：同一条消息重试时覆盖旧记录，不重复占额度。
 */
export function appendCacheDrop(
  existing: readonly CacheDrop[],
  drop: CacheDrop,
  maxRecords: number,
): readonly CacheDrop[] {
  const unique = new Map<string, CacheDrop>()
  for (const item of existing) unique.set(item.messageID, item)
  unique.set(drop.messageID, drop)
  return [...unique.values()]
    .sort((left, right) => left.at - right.at || left.messageID.localeCompare(right.messageID))
    .slice(-Math.max(1, maxRecords))
}

/** 输入：两条记录；输出：是否完全一致；用于避免无变化时重复写盘。 */
export function cacheDropsEqual(left: readonly CacheDrop[], right: readonly CacheDrop[]): boolean {
  if (left.length !== right.length) return false
  return left.every((drop, index) => {
    const other = right[index]
    if (other === undefined) return false
    return drop.messageID === other.messageID && drop.at === other.at && drop.dropPp === other.dropPp
  })
}
