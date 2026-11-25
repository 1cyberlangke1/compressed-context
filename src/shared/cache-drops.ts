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
  /** 段标识：顶层标量是字段名（`system`），数组是 `字段名[下标]`（`messages[7]`）。 */
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
  /** 只追加时新增的尾部段；用于面板展示后缀变化。 */
  readonly appended?: CacheDropBreak
  /** 当前请求的结构轮廓。 */
  readonly outline?: readonly CacheDropSegment[]
  /** 当前请求的 JSON 层级结构树；旧记录没有。 */
  readonly tree?: readonly CacheDropNode[]
  /** 断点段的原始文本（截断）。 */
  readonly request?: CacheDropRequest
}

/**
 * 请求体的一个顶层字段。
 * 数组按元素拆成多段（`messages[3]`），其余字段整体一段（`system` / `temperature`）。
 */
interface Field {
  readonly key: string
  readonly array: boolean
  readonly items: readonly string[]
}

/** 请求结构树的一个节点；只存键名、字符数、可选子节点和叶子的少量原文。 */
export interface CacheDropNode {
  readonly key: string
  readonly chars: number
  /** 叶子节点的原文（截断）；对象/数组节点没有。 */
  readonly text?: string
  /** `text` 是否是截断后的。 */
  readonly truncated?: boolean
  readonly children?: readonly CacheDropNode[]
}

/** 树最多保留的节点数，防止超大请求把记录撑爆。 */
export const TREE_MAX_NODES = 200
/** 树最多展开的 JSON 层级。 */
export const TREE_MAX_DEPTH = 4
/** 单个叶子最多存多少字符的原文。 */
export const NODE_TEXT_MAX_CHARS = 600
/** 整棵树最多存多少字符的叶子原文。 */
export const TREE_TEXT_BUDGET = 8_000

/**
 * 输入：任意 JSON 值 + 当前层级 + 剩余节点预算 + 剩余原文预算。
 * 输出：这一层的子节点；没有子节点时返回 undefined。
 * 预期：按 JSON 实际嵌套层级生成，数组元素键是 `[i]`，对象用字段名；
 *       叶子存一份截断原文，供弹窗里点开查看。
 */
function childNodes(
  value: unknown,
  depth: number,
  budget: { left: number },
  textBudget: { left: number },
): readonly CacheDropNode[] | undefined {
  if (depth >= TREE_MAX_DEPTH || budget.left <= 0) return undefined
  const entries: readonly (readonly [string, unknown])[] = Array.isArray(value)
    ? value.map((item, index) => [`[${index.toString()}]`, item] as const)
    : typeof value === "object" && value !== null
      ? Object.entries(value as Record<string, unknown>)
      : []
  if (entries.length === 0) return undefined
  const nodes: CacheDropNode[] = []
  for (const [key, item] of entries) {
    if (budget.left <= 0) break
    budget.left -= 1
    const children = childNodes(item, depth + 1, budget, textBudget)
    const chars = Array.from(canonicalJson(item)).length
    if (children !== undefined) {
      nodes.push({ key, chars, children })
      continue
    }
    const text = leafText(item, textBudget)
    nodes.push({
      key,
      chars,
      ...(text === undefined ? {} : { text: text.text, truncated: text.truncated }),
    })
  }
  return nodes.length === 0 ? undefined : nodes
}

/** 输入：叶子值 + 剩余原文预算；输出：截断后的原文；预算用完时返回 undefined。 */
function leafText(value: unknown, budget: { left: number }): { text: string; truncated: boolean } | undefined {
  if (budget.left <= 0) return undefined
  const full = canonicalJson(value)
  const points = Array.from(full)
  const size = Math.min(points.length, NODE_TEXT_MAX_CHARS, budget.left)
  budget.left -= size
  return { text: points.slice(0, size).join(""), truncated: size < points.length }
}

/** 输入：原始请求体；输出：按 JSON 层级展开的结构树；解析失败时为空数组。 */
export function treeFromBody(body: string): readonly CacheDropNode[] {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return []
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return []
  return childNodes(value, 0, { left: TREE_MAX_NODES }, { left: TREE_TEXT_BUDGET }) ?? []
}

/** 一次请求差异的完整结果。 */
export interface RequestDiff {
  readonly cause: CacheDropCause
  readonly breakPoint?: CacheDropBreak
  /** 只追加新内容时的尾部片段；前缀没断，但后缀变长了。 */
  readonly appended?: CacheDropBreak
  /** 当前请求的段轮廓；解析失败时为空数组。 */
  readonly outline: readonly CacheDropSegment[]
  /** 当前请求的 JSON 层级结构树。 */
  readonly tree: readonly CacheDropNode[]
  /** 断点段原文；没有断点时缺省。 */
  readonly request?: CacheDropRequest
}

/** 摘录在断点前保留的码点数。 */
const EXCERPT_LEAD = 40
/** 摘录总长（码点）。 */
const EXCERPT_LENGTH = 96
/** 原始请求片段最多存这么多码点，避免 100 条记录撑爆 storage。 */
export const REQUEST_TEXT_MAX_CHARS = 2_400

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

/**
 * 输入：原始请求体。
 * 输出：按 JSON 顶层字段出现顺序拆开的段；不是 JSON 对象时返回 undefined。
 * 预期：不认任何协议名——数组逐元素、其余字段整体一段，任意厂商的请求形状都能拆。
 */
function fieldsOf(body: string): readonly Field[] | undefined {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  return Object.entries(record).map(([key, item]) =>
    Array.isArray(item)
      ? { key, array: true, items: item.map(canonicalJson) }
      : { key, array: false, items: [canonicalJson(item)] },
  )
}

/** 输入：顶层字段；输出：请求结构轮廓（段标识 + 字符数）。 */
function outlineOf(fields: readonly Field[]): readonly CacheDropSegment[] {
  const segments: CacheDropSegment[] = []
  for (const field of fields) {
    if (!field.array) {
      segments.push({ key: field.key, chars: Array.from(field.items[0] ?? "").length })
      continue
    }
    field.items.forEach((text, index) => {
      segments.push({ key: `${field.key}[${index.toString()}]`, chars: Array.from(text).length })
    })
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
  const fields = fieldsOf(body)
  return fields === undefined ? [] : outlineOf(fields)
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

/** 输入：字段 + 段内下标；输出：段标识（`messages[3]` / `system`）。 */
function segmentName(field: Field, index: number): string {
  return field.array ? `${field.key}[${index.toString()}]` : field.key
}

/**
 * 输入：变化的字段 + 是否窗口后移。
 * 输出：缓存突变归类。
 * 预期：只按字段语义判断，不依赖厂商协议名；未知标量归为请求参数。
 */
function causeOf(field: Field, windowShift: boolean): CacheDropCause {
  const name = field.key.toLowerCase()
  if (name.includes("tool")) return "tools"
  if (name.includes("system") || name.includes("instruction") || name.includes("prompt")) return "system"
  if (field.array) return windowShift ? "window" : "history"
  return "params"
}

/** 输入：两侧字段；输出：首条数组字段的首项是否是上一轮更靠后的某项（窗口后移）。 */
function isWindowShift(prev: readonly Field[], next: readonly Field[]): boolean {
  const field = next.find((item) => item.array)
  if (field === undefined) return false
  const first = field.items[0]
  if (first === undefined) return false
  const before = prev.find((item) => item.key === field.key)
  if (before === undefined) return false
  return before.items.findIndex((item) => item === first) > 0
}

/** 输入：段标识 + 两侧原文；输出：新增/删除段的断点（偏移固定为 0）。 */
function edgeBreak(segment: string, before: string, after: string): CacheDropBreak {
  return {
    segment,
    offset: 0,
    before: Array.from(before).slice(0, EXCERPT_LENGTH).join(""),
    after: Array.from(after).slice(0, EXCERPT_LENGTH).join(""),
  }
}

/**
 * 输入：上一轮与这一轮的原始请求体。
 * 输出：首个差异归类、断点摘录、当前请求轮廓与断点段原文。
 * 预期：按顶层字段逐段对比（数组逐元素），不认协议名；解析失败时不声称有断点。
 */
export function diffRequests(prevBody: string, nextBody: string): RequestDiff {
  const prev = fieldsOf(prevBody)
  const next = fieldsOf(nextBody)
  if (prev === undefined || next === undefined) return { cause: "none", outline: [], tree: [] }
  const outline = outlineOf(next)
  const tree = treeFromBody(nextBody)
  const prevByKey = new Map(prev.map((field) => [field.key, field] as const))
  const nextByKey = new Map(next.map((field) => [field.key, field] as const))
  const windowShift = isWindowShift(prev, next)
  let grown: { readonly field: Field; readonly index: number } | undefined

  for (const field of next) {
    const before = prevByKey.get(field.key)
    if (before === undefined) {
      const first = field.items[0]
      if (first === undefined) continue
      const segment = segmentName(field, 0)
      return {
        cause: causeOf(field, windowShift),
        breakPoint: edgeBreak(segment, "", first),
        outline,
        tree,
        request: requestOf(segment, first),
      }
    }
    const limit = Math.min(before.items.length, field.items.length)
    for (let index = 0; index < limit; index += 1) {
      const left = before.items[index]
      const right = field.items[index]
      if (left === undefined || right === undefined || left === right) continue
      const segment = segmentName(field, index)
      return {
        cause: causeOf(field, windowShift),
        breakPoint: excerptOf(segment, left, right, firstDifference(Array.from(left), Array.from(right))),
        outline,
        tree,
        request: requestOf(segment, right),
      }
    }
    if (field.items.length > before.items.length && grown === undefined) {
      grown = { field, index: before.items.length }
    }
  }

  // 整段字段消失：按请求顺序报第一个缺失字段。
  for (const field of prev) {
    if (nextByKey.has(field.key)) continue
    const removed = field.items[0]
    if (removed === undefined) continue
    const segment = segmentName(field, 0)
    return {
      cause: causeOf(field, false),
      breakPoint: edgeBreak(segment, removed, ""),
      outline,
      tree,
      request: requestOf(segment, removed),
    }
  }

  // 同一字段尾部被截断。
  for (const field of next) {
    const before = prevByKey.get(field.key)
    if (before === undefined || before.items.length <= field.items.length) continue
    const removed = before.items[field.items.length]
    if (removed === undefined) continue
    const segment = segmentName(field, field.items.length)
    return {
      cause: causeOf(field, windowShift),
      breakPoint: edgeBreak(segment, removed, ""),
      outline,
      tree,
      request: requestOf(segment, removed),
    }
  }

  if (grown !== undefined) {
    const added = grown.field.items[grown.index]
    if (added === undefined) return { cause: "append", outline, tree }
    return {
      cause: "append",
      outline,
      tree,
      appended: {
        segment: segmentName(grown.field, grown.index),
        offset: 0,
        before: "",
        after: Array.from(added).slice(0, EXCERPT_LENGTH).join(""),
      },
    }
  }
  return { cause: "none", outline, tree }
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
  const appended = parseBreak(record["appended"])
  const outline = parseOutline(record["outline"])
  const tree = parseTree(record["tree"])
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
    ...(appended === undefined ? {} : { appended }),
    ...(outline === undefined ? {} : { outline }),
    ...(tree === undefined ? {} : { tree }),
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

/** 输入：任意值；输出：合法结构树或 undefined；非法节点直接丢弃该分支。 */
function parseTree(value: unknown, depth = 0): readonly CacheDropNode[] | undefined {
  if (depth > 8 || !Array.isArray(value)) return undefined
  const nodes: CacheDropNode[] = []
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue
    const record = item as Record<string, unknown>
    const key = record["key"]
    const chars = record["chars"]
    if (typeof key !== "string" || key.length === 0) continue
    if (typeof chars !== "number" || !Number.isFinite(chars) || chars < 0) continue
    const children = parseTree(record["children"], depth + 1)
    const text = record["text"]
    const truncated = record["truncated"]
    nodes.push({
      key,
      chars,
      ...(typeof text === "string" ? { text } : {}),
      ...(typeof truncated === "boolean" ? { truncated } : {}),
      ...(children === undefined ? {} : { children }),
    })
  }
  return nodes.length === 0 ? undefined : nodes
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
