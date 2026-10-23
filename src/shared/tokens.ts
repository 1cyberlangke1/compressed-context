import { attachmentTokens } from "./media.ts"
import { stringify, toolInput, toolResult, toolResultText } from "./parts.ts"

/**
 * 上下文分类 token 估算。
 *
 * 输入：`context` 钩子里的 system / tools / messages 原始结构。
 * 输出：各类别的 token 估算值（system、tools、tool、text、code、summaries、media）。
 * 预期：只用于计算「各类占多少比例」；绝对总量以 provider 返回的 usage 为准，
 *       展示层按真实总量缩放，所以这里的绝对值允许有偏差。
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

/** CJK 字符按 1 token 计，其余按 4 字符 1 token 向上取整。 */
export function countText(text: string): number {
  if (text.length === 0) return 0
  const cjk = text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/gu)
  const cjkCount = cjk?.length ?? 0
  return cjkCount + Math.ceil((text.length - cjkCount) / 4)
}

/** 输入：工具结果里的单个 content 项；输出：token 估算。 */
function countToolResultItem(item: unknown): number {
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
    if (typed.type === "text" && typeof typed.text === "string") return countText(typed.text)
    if (typed.type === "file") {
      return attachmentTokens({ mime: typed.mime })
    }
    if (typed.type === "media") {
      return attachmentTokens({
        mime: typed.media?.mediaType ?? typed.media?.source?.mediaType,
        data: typed.media?.source?.data,
        durationSeconds: typed.media?.durationSeconds,
      })
    }
  }
  return countText(toolResultText(item))
}

/** 输入：工具结果；输出：token 估算；预期：v2 的 content 数组和旧 result 都能计数。 */
function countToolResult(result: unknown): number {
  if (Array.isArray(result)) {
    return result.reduce<number>((sum, item) => sum + countToolResultItem(item), 0)
  }
  if (typeof result === "object" && result !== null) {
    const typed = result as { readonly content?: unknown; readonly value?: unknown; readonly output?: unknown }
    if (Array.isArray(typed.content)) return countToolResult(typed.content)
    if (Array.isArray(typed.value)) return countToolResult(typed.value)
    if (typed.output !== undefined) return countToolResult(typed.output)
  }
  return countText(toolResultText(result))
}

const CHECKPOINT_PREFIX = "<conversation-checkpoint>"
const SUMMARY_TAG = /<summary>([\s\S]*?)<\/summary>/
const RECENT_TAG = /<recent-context>([\s\S]*?)<\/recent-context>/

/**
 * 输入：checkpoint 文本。
 * 输出：摘要与最近上下文两部分的 token 估算。
 * 预期：只把 <summary> 计入摘要；<recent-context> 是逐字保留的最近对话，
 *       单独计数，避免把最近上下文误当成摘要。
 */
function countCheckpoint(text: string): { readonly summary: number; readonly recent: number } {
  const summary = SUMMARY_TAG.exec(text)?.[1]
  const recent = RECENT_TAG.exec(text)?.[1]
  if (summary === undefined && recent === undefined) {
    return { summary: countText(text), recent: 0 }
  }
  return { summary: countText(summary ?? ""), recent: countText(recent ?? "") }
}

/**
 * 输入：system 片段、工具定义表、消息列表。
 * 输出：按类别汇总的 token 估算。
 * 预期：所有 text / reasoning 都归入 text（代码块不再单列）；tool-call 与 tool-result 归入 tool。
 */
export function estimateCategories(input: {
  readonly system: readonly SystemPartLike[]
  readonly tools: Readonly<Record<string, ToolDefinitionLike>>
  readonly messages: readonly MessageLike[]
}): TokenCategories {
  let system = 0
  for (const part of input.system) {
    if (part.type === "text") system += countText(part.text)
  }

  let tools = 0
  for (const [name, definition] of Object.entries(input.tools)) {
    tools += countText(`${name}${definition.description ?? ""}${stringify(definition.input)}`)
  }

  let tool = 0
  let text = 0
  let recent = 0
  let summaries = 0
  let media = 0

  for (const message of input.messages) {
    const content: readonly ContentPartLike[] = Array.isArray(message.content)
      ? message.content
      : []
    const contentHasText = content.some((part) => part.type === "text")
    if (!contentHasText && typeof message.text === "string") text += countText(message.text)
    for (const part of content) {
      switch (part.type) {
        case "text": {
          const value = part.text ?? ""
          if (value.trimStart().startsWith(CHECKPOINT_PREFIX)) {
            const checkpoint = countCheckpoint(value)
            summaries += checkpoint.summary
            // 只保留最后一个 checkpoint 的 recent：旧 checkpoint 的 recent 不应再累加，
            // 否则同一段最近对话会被算多次。
            recent = checkpoint.recent
          } else text += countText(value)
          break
        }
        case "reasoning": {
          text += countText(part.text ?? "")
          break
        }
        case "tool-call": {
          tool += countText(`${part.name ?? ""}${stringify(toolInput(part))}`)
          break
        }
        case "tool-result": {
          tool += countToolResult(toolResult(part))
          break
        }
        case "tool": {
          tool += countText(`${part.name ?? ""}${stringify(toolInput(part))}`)
          tool += countToolResult(toolResult(part))
          break
        }
        case "compaction": {
          summaries += countText(part.text ?? "")
          break
        }
        case "file": {
          media += attachmentTokens({
            mime: part.file?.mime,
            data: part.file?.data,
            durationSeconds: part.file?.durationSeconds,
          })
          break
        }
        case "media": {
          media += attachmentTokens({
            mime: part.media?.source?.mediaType,
            data: part.media?.source?.data,
            width: part.media?.info?.width,
            height: part.media?.info?.height,
            durationSeconds: part.media?.info?.durationSeconds,
          })
          break
        }
        default: {
          break
        }
      }
    }
  }

  return { system, tools, tool, text, recent, summaries, media }
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
