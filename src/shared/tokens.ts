import { attachmentTokens } from "./media.ts"
import { formatTokens } from "./format.ts"
import { CHECKPOINT_PREFIX, RECENT_TAG, SUMMARY_TAG, stringify, toolInput, toolResult, toolResultText } from "./parts.ts"

/**
 * 上下文分类 token 估算（13 桶线性模型）。
 *
 * 输入：`context` 钩子里的 system / tools / messages 原始结构 + 每模型系数。
 * 输出：各类别的 token 估算值。
 * 预期：一次左到右扫描把字符分进 13 个桶，再按 `Σ 计数 × 系数` 折算；
 *       默认系数是离线拟合的先验，运行时按模型在线修正。
 */

/** 单条消息内容的最小结构，避免绑定 @opencode/ai 的具体类。 */
export interface FileAttachmentLike {
  readonly mime?: string | undefined
  readonly data?: string | Uint8Array | undefined
  readonly name?: string | undefined
  readonly uri?: string | undefined
  readonly durationSeconds?: number | undefined
}

export interface ContentPartLike {
  readonly type: string
  readonly text?: string | null | undefined
  readonly name?: string | undefined
  readonly input?: unknown
  readonly result?: unknown
  readonly state?:
    | {
        readonly input?: unknown
        readonly content?: unknown
        readonly output?: unknown
      }
    | undefined
  readonly file?: FileAttachmentLike | undefined
  readonly media?:
    | {
        readonly source?:
          | {
              readonly type?: string | undefined
              readonly data?: string | Uint8Array | undefined
              readonly mediaType?: string | undefined
            }
          | undefined
        readonly info?:
          | {
              readonly width?: number | undefined
              readonly height?: number | undefined
              readonly durationSeconds?: number | undefined
            }
          | undefined
      }
    | undefined
}

export interface MessageLike {
  readonly role?: string
  readonly content: readonly ContentPartLike[]
  /** @opencode/ai 的 Message 用 content；保留 text 兼容旧的扁平静态消息。 */
  readonly text?: string | null | undefined
}

export interface SystemPartLike {
  readonly type: string
  readonly text: string
}

export interface ToolDefinitionLike {
  readonly description?: string
  readonly input?: unknown
}

export interface TokenCategories {
  readonly system: number
  readonly tools: number
  readonly tool: number
  readonly text: number
  readonly recent: number
  readonly summaries: number
  readonly media: number
}

/**
 * 13 个桶：按 BPE 实际行为切，而不是按 Unicode 区块。
 * `cjk` 含汉字/假名/谚文/全角标点；`other` 是非 ASCII 非 CJK 的其余字符。
 */
export type BucketName =
  | "cjk"
  | "latin"
  | "other"
  | "num"
  | "ws"
  | "asciiPunct"
  | "punctRun"
  | "word2"
  | "word35"
  | "word68"
  | "longChars"
  | "camel"
  | "caps"

/** 桶的固定顺序：存储与 RPC 都按这个下标对齐。 */
export const BUCKET_NAMES: readonly BucketName[] = [
  "cjk",
  "latin",
  "other",
  "num",
  "ws",
  "asciiPunct",
  "punctRun",
  "word2",
  "word35",
  "word68",
  "longChars",
  "camel",
  "caps",
]

/** 每桶计数。 */
export type BucketCounts = Readonly<Record<BucketName, number>>
/** 每桶系数（每字符/每单位折算多少 token）。 */
export type BucketCoefs = Readonly<Record<BucketName, number>>

/**
 * 离线拟合的先验系数（参考 o200k_base，36k 真实会话文本，out-of-sample MAE 5.96%）。
 * 运行时会被按模型学到的值替代；没有样本时就是这套。
 */
export const DEFAULT_BUCKET_COEFS: BucketCoefs = {
  cjk: 0.8325,
  latin: 0.1476,
  other: 1.2097,
  num: 1.5307,
  ws: 0.1785,
  asciiPunct: 0.1586,
  punctRun: 0.6493,
  word2: 0.6592,
  word35: 0.3047,
  word68: 0.0463,
  longChars: 0,
  camel: 0.4249,
  caps: 0.0932,
}

/** 输入：无；输出：全零桶计数。 */
export function emptyBuckets(): Record<BucketName, number> {
  return {
    cjk: 0,
    latin: 0,
    other: 0,
    num: 0,
    ws: 0,
    asciiPunct: 0,
    punctRun: 0,
    word2: 0,
    word35: 0,
    word68: 0,
    longChars: 0,
    camel: 0,
    caps: 0,
  }
}

/** 输入：桶名；输出：该维系数的合法区间（相对先验的一半到两倍）。 */
export function bucketBand(name: BucketName): { readonly lo: number; readonly hi: number } {
  const prior = DEFAULT_BUCKET_COEFS[name]
  if (prior <= 0) return { lo: 0, hi: 0.6 }
  return { lo: Math.max(0, prior * 0.5 - 0.05), hi: prior * 2 + 0.1 }
}

/** 输入：文本；输出：桶计数；预期：单次左到右扫描，astral 字符按一个 `other` 计。 */
export function bucketize(text: string): BucketCounts {
  const b = emptyBuckets()
  const n = text.length
  let i = 0
  while (i < n) {
    const code = text.codePointAt(i) ?? 0
    const size = code > 0xffff ? 2 : 1

    if (isSpaceCode(code)) {
      let j = i
      while (j < n) {
        const next = text.codePointAt(j) ?? 0
        if (!isSpaceCode(next)) break
        j += next > 0xffff ? 2 : 1
      }
      b.ws += 1
      i = j
      continue
    }

    if (isCjkCode(code)) {
      let j = i
      while (j < n) {
        const next = text.codePointAt(j) ?? 0
        if (!isCjkCode(next)) break
        b.cjk += 1
        j += next > 0xffff ? 2 : 1
      }
      i = j
      continue
    }

    if (isDigitCode(code)) {
      let j = i
      let count = 0
      while (j < n) {
        const next = text.codePointAt(j) ?? 0
        if (!isDigitCode(next)) break
        count += 1
        j += next > 0xffff ? 2 : 1
      }
      b.num += Math.ceil(count / 3)
      i = j
      continue
    }

    if (isLetterCode(code)) {
      let j = i
      while (j < n) {
        const next = text.codePointAt(j) ?? 0
        if (!isLetterCode(next)) break
        j += next > 0xffff ? 2 : 1
      }
      const length = j - i
      const word = text.slice(i, j)
      b.latin += length
      if (length >= 2 && word === word.toUpperCase()) b.caps += length
      else if (length <= 2) b.word2 += 1
      else if (length <= 5) b.word35 += 1
      else if (length <= 8) b.word68 += 1
      else b.longChars += length
      b.camel += camelBoundaries(word)
      i = j
      continue
    }

    if (isAsciiPunctCode(code)) {
      let j = i
      let count = 0
      while (j < n) {
        const next = text.codePointAt(j) ?? 0
        if (!isAsciiPunctCode(next)) break
        count += 1
        j += next > 0xffff ? 2 : 1
      }
      b.punctRun += 1
      b.asciiPunct += count
      i = j
      continue
    }

    // 其余（emoji、全角符号、西里尔、变体选择符…）统一计入 other。
    b.other += 1
    i += size
  }
  return b
}

/** 输入：一个拉丁词；输出：小写→大写的边界数（camelCase）。 */
function camelBoundaries(word: string): number {
  let count = 0
  for (let i = 1; i < word.length; i += 1) {
    const prev = word.charCodeAt(i - 1)
    const cur = word.charCodeAt(i)
    if (cur >= 0x41 && cur <= 0x5a && prev >= 0x61 && prev <= 0x7a) count += 1
  }
  return count
}

/** 输入：码点；输出：是否空白。 */
function isSpaceCode(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0x85 ||
    code === 0xa0 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  )
}

/** 输入：码点；输出：是否 CJK 类（汉字/假名/谚文/CJK 标点/全角）。 */
function isCjkCode(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0x2fff) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0x3100 && code <= 0x312f) ||
    (code >= 0x3130 && code <= 0x318f) ||
    (code >= 0x31f0 && code <= 0x31ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x20000 && code <= 0x2fa1f)
  )
}

/** 输入：码点；输出：是否十进制数字。 */
function isDigitCode(code: number): boolean {
  return code >= 0x30 && code <= 0x39
}

/** 输入：码点；输出：是否字母（ASCII + 带音标拉丁扩展）。 */
function isLetterCode(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || (code >= 0xc0 && code <= 0x24f)
}

/** 输入：码点；输出：是否 ASCII 标点（逗号句号等，单引号除外）。 */
function isAsciiPunctCode(code: number): boolean {
  if (code === 0x27) return false
  return (code >= 0x21 && code <= 0x2f) || (code >= 0x3a && code <= 0x40) || (code >= 0x5b && code <= 0x60) || (code >= 0x7b && code <= 0x7e)
}

/** 输入：桶计数 + 系数；输出：token 估算；预期：四舍五入，至少 0。 */
export function priceBuckets(counts: BucketCounts, coefs: BucketCoefs = DEFAULT_BUCKET_COEFS): number {
  let total = 0
  for (const name of BUCKET_NAMES) total += counts[name] * coefs[name]
  return total <= 0 ? 0 : Math.round(total)
}

/** 输入：文本 + 系数；输出：token 估算。 */
export function priceText(text: string, coefs: BucketCoefs = DEFAULT_BUCKET_COEFS): number {
  return priceBuckets(bucketize(text), coefs)
}

/**
 * 输入：文本。
 * 输出：固定默认系数下的 token 估算。
 * 预期：块字符上限、摘要校验这类「字符口径」的地方继续用它，不受模型校准影响。
 */
export function countText(text: string): number {
  if (text.length === 0) return 0
  const cjk = text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/gu)?.length ?? 0
  return cjk + Math.ceil((text.length - cjk) / 4)
}

/** 内部累加器：桶计数 + 直接以 token 计的媒体部分。 */
interface Acc {
  buckets: Record<BucketName, number>
  extra: number
}

/** 输入：无；输出：空累加器。 */
function emptyAcc(): Acc {
  return { buckets: emptyBuckets(), extra: 0 }
}

/** 输入：累加器 + 文本；输出：无；预期：把文本的桶计数加进去。 */
function addText(acc: Acc, text: string): void {
  const counted = bucketize(text)
  for (const name of BUCKET_NAMES) acc.buckets[name] += counted[name]
}

/** 输入：累加器 + 直接 token 数；输出：无。 */
function addTokens(acc: Acc, tokens: number): void {
  acc.extra += tokens
}

/** 输入：累加器 + 系数；输出：token 估算。 */
function accTokens(acc: Acc, coefs: BucketCoefs): number {
  return priceBuckets(acc.buckets, coefs) + acc.extra
}

/** 输入：工具结果里的单个 content 项；输出：无；预期：把字符/媒体计入累加器。 */
function collectToolResultItem(item: unknown, acc: Acc): void {
  if (typeof item === "object" && item !== null) {
    const typed = item as {
      readonly type?: unknown
      readonly text?: unknown
      readonly mime?: string
      readonly uri?: string
      readonly name?: string
      readonly media?:
        | {
            readonly mediaType?: string
            readonly durationSeconds?: number
            readonly source?: { readonly data?: string | Uint8Array; readonly mediaType?: string }
          }
        | undefined
    }
    if (typed.type === "text" && typeof typed.text === "string") {
      addText(acc, typed.text)
      return
    }
    if (typed.type === "file") {
      addTokens(acc, attachmentTokens({ mime: typed.mime }))
      return
    }
    if (typed.type === "media") {
      addTokens(
        acc,
        attachmentTokens({
          mime: typed.media?.mediaType ?? typed.media?.source?.mediaType,
          data: typed.media?.source?.data,
          durationSeconds: typed.media?.durationSeconds,
        }),
      )
      return
    }
  }
  addText(acc, toolResultText(item))
}

/** 输入：工具结果；输出：无；预期：v2 的 content 数组和旧 result 都能计数。 */
function collectToolResult(result: unknown, acc: Acc): void {
  if (Array.isArray(result)) {
    for (const item of result) collectToolResultItem(item, acc)
    return
  }
  if (typeof result === "object" && result !== null) {
    const typed = result as { readonly content?: unknown; readonly value?: unknown; readonly output?: unknown }
    if (Array.isArray(typed.content)) {
      collectToolResult(typed.content, acc)
      return
    }
    if (Array.isArray(typed.value)) {
      collectToolResult(typed.value, acc)
      return
    }
    if (typed.output !== undefined) {
      collectToolResult(typed.output, acc)
      return
    }
  }
  addText(acc, toolResultText(result))
}

/**
 * 输入：checkpoint 文本。
 * 输出：摘要与最近上下文两部分的累加器。
 * 预期：只把 <summary> 计入摘要；<recent-context> 是逐字保留的最近对话，
 *       单独计数，避免把最近上下文误当成摘要。
 */
function collectCheckpoint(text: string): { readonly summary: Acc; readonly recent: Acc } {
  const summary = SUMMARY_TAG.exec(text)?.[1]
  const recent = RECENT_TAG.exec(text)?.[1]
  if (summary === undefined && recent === undefined) {
    const all = emptyAcc()
    addText(all, text)
    return { summary: all, recent: emptyAcc() }
  }
  const summaryAcc = emptyAcc()
  const recentAcc = emptyAcc()
  addText(summaryAcc, summary ?? "")
  addText(recentAcc, recent ?? "")
  return { summary: summaryAcc, recent: recentAcc }
}

/** 每类一份累加器。 */
interface CharCategories {
  readonly system: Acc
  readonly tools: Acc
  readonly tool: Acc
  readonly text: Acc
  readonly recent: Acc
  readonly summaries: Acc
  readonly media: Acc
}

/**
 * 输入：system 片段、工具定义表、消息列表。
 * 输出：按类别累计的桶计数与媒体 token。
 * 预期：所有 text / reasoning 都归入 text；tool-call 与 tool-result 归入 tool；
 *       只保留最后一个 checkpoint 的 recent，旧 checkpoint 的 recent 不重复累加。
 */
function collectBuckets(input: {
  readonly system: readonly SystemPartLike[]
  readonly tools: Readonly<Record<string, ToolDefinitionLike>>
  readonly messages: readonly MessageLike[]
}): CharCategories {
  const categories: CharCategories = {
    system: emptyAcc(),
    tools: emptyAcc(),
    tool: emptyAcc(),
    text: emptyAcc(),
    recent: emptyAcc(),
    summaries: emptyAcc(),
    media: emptyAcc(),
  }

  for (const part of input.system) {
    if (part.type === "text") addText(categories.system, part.text)
  }

  for (const [name, definition] of Object.entries(input.tools)) {
    addText(categories.tools, `${name}${definition.description ?? ""}${stringify(definition.input)}`)
  }

  for (const message of input.messages) {
    const content: readonly ContentPartLike[] = Array.isArray(message.content) ? message.content : []
    const contentHasText = content.some((part) => part.type === "text")
    if (!contentHasText && typeof message.text === "string") addText(categories.text, message.text)
    for (const part of content) {
      switch (part.type) {
        case "text": {
          const value = part.text ?? ""
          if (value.trimStart().startsWith(CHECKPOINT_PREFIX)) {
            const checkpoint = collectCheckpoint(value)
            for (const name of BUCKET_NAMES) categories.summaries.buckets[name] += checkpoint.summary.buckets[name]
            categories.summaries.extra += checkpoint.summary.extra
            // 只保留最后一个 checkpoint 的 recent：旧 checkpoint 的 recent 不应再累加。
            for (const name of BUCKET_NAMES) categories.recent.buckets[name] = checkpoint.recent.buckets[name]
            categories.recent.extra = checkpoint.recent.extra
          } else {
            addText(categories.text, value)
          }
          break
        }
        case "reasoning": {
          addText(categories.text, part.text ?? "")
          break
        }
        case "tool-call": {
          addText(categories.tool, `${part.name ?? ""}${stringify(toolInput(part))}`)
          break
        }
        case "tool-result": {
          collectToolResult(toolResult(part), categories.tool)
          break
        }
        case "tool": {
          addText(categories.tool, `${part.name ?? ""}${stringify(toolInput(part))}`)
          collectToolResult(toolResult(part), categories.tool)
          break
        }
        case "compaction": {
          addText(categories.summaries, part.text ?? "")
          break
        }
        case "file": {
          addTokens(
            categories.media,
            attachmentTokens({
              mime: part.file?.mime,
              data: part.file?.data,
              durationSeconds: part.file?.durationSeconds,
            }),
          )
          break
        }
        case "media": {
          addTokens(
            categories.media,
            attachmentTokens({
              mime: part.media?.source?.mediaType,
              data: part.media?.source?.data,
              width: part.media?.info?.width,
              height: part.media?.info?.height,
              durationSeconds: part.media?.info?.durationSeconds,
            }),
          )
          break
        }
        default: {
          break
        }
      }
    }
  }

  return categories
}

/**
 * 输入：system 片段、工具定义表、消息列表、可选系数。
 * 输出：按类别汇总的 token 估算。
 * 预期：系数来自模型校准；缺省时等于离线先验。
 */
export function estimateCategories(
  input: {
    readonly system: readonly SystemPartLike[]
    readonly tools: Readonly<Record<string, ToolDefinitionLike>>
    readonly messages: readonly MessageLike[]
  },
  coefs: BucketCoefs = DEFAULT_BUCKET_COEFS,
): TokenCategories {
  const categories = collectBuckets(input)
  return {
    system: accTokens(categories.system, coefs),
    tools: accTokens(categories.tools, coefs),
    tool: accTokens(categories.tool, coefs),
    text: accTokens(categories.text, coefs),
    recent: accTokens(categories.recent, coefs),
    summaries: accTokens(categories.summaries, coefs),
    media: accTokens(categories.media, coefs),
  }
}

/**
 * 输入：system 片段、工具定义表、消息列表。
 * 输出：整段提示词的桶计数（不含媒体）。
 * 预期：供校准模块把「真实 prompt token ÷ 桶计数」作为观测样本。
 */
export function estimateBuckets(input: {
  readonly system: readonly SystemPartLike[]
  readonly tools: Readonly<Record<string, ToolDefinitionLike>>
  readonly messages: readonly MessageLike[]
}): BucketCounts {
  const categories = collectBuckets(input)
  const total = emptyBuckets()
  for (const acc of [
    categories.system,
    categories.tools,
    categories.tool,
    categories.text,
    categories.recent,
    categories.summaries,
    categories.media,
  ]) {
    for (const name of BUCKET_NAMES) total[name] += acc.buckets[name]
  }
  return total
}

/**
 * 输入：分类估算。
 * 输出：真正会随对话推进增长、也是压缩要折叠的内容 token：工具定义 + 工具结果 + 文本 + 媒体。
 * 预期：提醒只该看这部分；系统提示词、已有摘要块、最近保留区都不算「新长出来的内容」。
 */
export function contentCategories(categories: TokenCategories): number {
  return categories.tools + categories.tool + categories.text + categories.media
}

/**
 * 输入：分类估算。
 * 输出：一行构成摘要，如 `12.0k system | 5.3k tools | 45.2k tool | 15.1k text | 38.0k summaries`。
 * 预期：只列出非零类别，媒体非零时插在文本之后；全为 0 时返回空串。
 */
export function formatCategoryBreakdown(categories: TokenCategories): string {
  const parts: string[] = []
  const push = (label: string, value: number): void => {
    if (value > 0) parts.push(`${formatTokens(value)} ${label}`)
  }
  push("system", categories.system)
  push("tools", categories.tools)
  push("tool", categories.tool)
  push("text", categories.text)
  push("media", categories.media)
  push("summaries", categories.summaries)
  return parts.join(" | ")
}

/** 输入：分类估算；输出：各类之和。 */
export function totalCategories(categories: TokenCategories): number {
  return (
    categories.system +
    categories.tools +
    categories.tool +
    categories.text +
    categories.recent +
    categories.summaries +
    categories.media
  )
}
