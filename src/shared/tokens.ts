import { attachmentTokens } from "./media.ts"
import { formatTokens } from "./format.ts"
import { CHECKPOINT_PREFIX, RECENT_TAG, SUMMARY_TAG, stringify, toolInput, toolResult, toolResultText } from "./parts.ts"

/**
 * 上下文分类 token 估算。
 *
 * 输入：`context` 钩子里的 system / tools / messages 原始结构。
 * 输出：各类别的 token 估算值（system、tools、tool、text、code、summaries、media）。
 * 预期：绝对总量由 provider 返回的 usage 校准：默认系数等价于旧规则
 *       （CJK 1 字 ≈ 1 token、其余 4 字符 ≈ 1 token），并按模型用真实 usage 学习，
 *       所以「面板显示」与「压缩阈值」用的是同一套系数。
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

/** 字符分类：CJK 与非 CJK 分开计数。 */
export interface CharCounts {
  readonly cjk: number
  readonly ascii: number
}

/** 每个 CJK / 非 CJK 字符折算多少 token。 */
export interface TokenCoefs {
  readonly cjk: number
  readonly ascii: number
}

/** 默认系数：等价于旧规则「CJK 1 字 1 token，其余 4 字符 1 token」。 */
export const DEFAULT_TOKEN_COEFS: TokenCoefs = { cjk: 1, ascii: 0.25 }

/** 校准系数的合法下限：越界的观测或手填都会被拒绝。 */
export const TOKEN_COEF_MIN: TokenCoefs = { cjk: 0.4, ascii: 0.05 }
/** 校准系数的合法上限。 */
export const TOKEN_COEF_MAX: TokenCoefs = { cjk: 2, ascii: 1 }

/** 输入：文本；输出：CJK 字符数与非 CJK 字符数。 */
export function countChars(text: string): CharCounts {
  if (text.length === 0) return { cjk: 0, ascii: 0 }
  const cjk = text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/gu)?.length ?? 0
  return { cjk, ascii: text.length - cjk }
}

/** 输入：字符数 + 系数；输出：估算 token（向上取整，默认系数下与旧规则逐字一致）。 */
export function charsTokens(chars: CharCounts, coefs: TokenCoefs = DEFAULT_TOKEN_COEFS): number {
  const value = chars.cjk * coefs.cjk + chars.ascii * coefs.ascii
  return value <= 0 ? 0 : Math.ceil(value)
}

/**
 * 输入：文本。
 * 输出：固定默认系数下的 token 估算。
 * 预期：块字符上限、摘要校验这类「字符口径」的地方继续用它，不受模型校准影响。
 */
export function countText(text: string): number {
  return charsTokens(countChars(text))
}

/** 内部累加器：字符数 + 直接以 token 计的媒体部分。 */
interface Acc {
  cjk: number
  ascii: number
  extra: number
}

/** 输入：无；输出：空累加器。 */
function emptyAcc(): Acc {
  return { cjk: 0, ascii: 0, extra: 0 }
}

/** 输入：累加器 + 文本；输出：无；预期：把文本字符数加进去。 */
function addText(acc: Acc, text: string): void {
  const chars = countChars(text)
  acc.cjk += chars.cjk
  acc.ascii += chars.ascii
}

/** 输入：累加器 + 直接 token 数；输出：无。 */
function addTokens(acc: Acc, tokens: number): void {
  acc.extra += tokens
}

/** 输入：累加器 + 系数；输出：token 估算。 */
function accTokens(acc: Acc, coefs: TokenCoefs): number {
  return charsTokens({ cjk: acc.cjk, ascii: acc.ascii }, coefs) + acc.extra
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

/** 每类一份累加器；media 单独走 extra。 */
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
 * 输出：按类别累计的字符数与媒体 token。
 * 预期：所有 text / reasoning 都归入 text（代码块不再单列）；tool-call 与 tool-result 归入 tool；
 *       只保留最后一个 checkpoint 的 recent，旧 checkpoint 的 recent 不重复累加。
 */
function collectCharCategories(input: {
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
            categories.summaries.cjk += checkpoint.summary.cjk
            categories.summaries.ascii += checkpoint.summary.ascii
            categories.summaries.extra += checkpoint.summary.extra
            // 只保留最后一个 checkpoint 的 recent：旧 checkpoint 的 recent 不应再累加，
            // 否则同一段最近对话会被算多次。
            categories.recent.cjk = checkpoint.recent.cjk
            categories.recent.ascii = checkpoint.recent.ascii
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
 * 预期：系数来自模型校准；缺省时等于旧规则，行为与历史版本一致。
 */
export function estimateCategories(
  input: {
    readonly system: readonly SystemPartLike[]
    readonly tools: Readonly<Record<string, ToolDefinitionLike>>
    readonly messages: readonly MessageLike[]
  },
  coefs: TokenCoefs = DEFAULT_TOKEN_COEFS,
): TokenCategories {
  const categories = collectCharCategories(input)
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
 * 输出：整段提示词的字符分类（不含媒体）。
 * 预期：供校准模块把「真实 prompt token ÷ 字符数」作为观测样本。
 */
export function estimateChars(input: {
  readonly system: readonly SystemPartLike[]
  readonly tools: Readonly<Record<string, ToolDefinitionLike>>
  readonly messages: readonly MessageLike[]
}): CharCounts {
  const categories = collectCharCategories(input)
  let cjk = 0
  let ascii = 0
  for (const acc of [
    categories.system,
    categories.tools,
    categories.tool,
    categories.text,
    categories.recent,
    categories.summaries,
    categories.media,
  ]) {
    cjk += acc.cjk
    ascii += acc.ascii
  }
  return { cjk, ascii }
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
