/**
 * 上下文分类 token 估算。
 *
 * 输入：`context` 钩子里的 system / tools / messages 原始结构。
 * 输出：各类别的 token 估算值（system、tools、tool、text、code、summaries、media）。
 * 预期：只用于计算「各类占多少比例」；绝对总量以 provider 返回的 usage 为准，
 *       展示层按真实总量缩放，所以这里的绝对值允许有偏差。
 */

/** 单条消息内容的最小结构，避免绑定 @opencode/ai 的具体类。 */
export interface ContentPartLike {
  readonly type: string
  readonly text?: string | null
  readonly name?: string
  readonly input?: unknown
  readonly result?: unknown
  readonly media?: { readonly mediaType?: string }
}

export interface MessageLike {
  readonly role?: string
  readonly content: readonly ContentPartLike[]
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
  readonly summaries: number
  readonly media: number
}

/** 图片 / PDF 的固定估算值，与 OpenCode 压缩预算的口径一致。 */
const IMAGE_TOKENS = 1_500
const PDF_TOKENS = 2_000

/** CJK 字符按 1 token 计，其余按 4 字符 1 token 向上取整。 */
export function countText(text: string): number {
  if (text.length === 0) return 0
  const cjk = text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/gu)
  const cjkCount = cjk?.length ?? 0
  return cjkCount + Math.ceil((text.length - cjkCount) / 4)
}

/** 把任意工具输入 / 结果转成可计数文本；不可序列化时按空串处理。 */
function stringify(value: unknown): string {
  if (typeof value === "string") return value
  if (value === undefined) return ""
  try {
    const encoded: unknown = JSON.stringify(value)
    return typeof encoded === "string" ? encoded : ""
  } catch {
    return ""
  }
}

/** 输入：媒体类型（可能缺失）；输出：token 估算；预期：非图片/PDF 返回 0。 */
function countMedia(mediaType: string | undefined): number {
  if (mediaType === undefined) return 0
  const type = mediaType.toLowerCase()
  if (type.startsWith("image/")) return IMAGE_TOKENS
  if (type === "application/pdf") return PDF_TOKENS
  return 0
}

/** 输入：tool-result 里的单个 content 项；输出：token 估算。 */
function countToolResultItem(item: unknown): number {
  if (typeof item === "object" && item !== null) {
    const typed = item as { readonly type?: unknown; readonly text?: unknown; readonly media?: { readonly mediaType?: string } }
    if (typed.type === "text" && typeof typed.text === "string") return countText(typed.text)
    if (typed.type === "media") return countMedia(typed.media?.mediaType)
  }
  return countText(stringify(item))
}

/** 输入：tool-result 的 result 值；输出：token 估算。 */
function countToolResult(result: unknown): number {
  if (typeof result !== "object" || result === null) return countText(stringify(result))
  const typed = result as { readonly value?: unknown }
  if (Array.isArray(typed.value)) {
    return typed.value.reduce<number>((sum, item) => sum + countToolResultItem(item), 0)
  }
  return countText(stringify(typed.value))
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
  let summaries = 0
  let media = 0

  for (const message of input.messages) {
    for (const part of message.content) {
      switch (part.type) {
        case "text": {
          text += countText(part.text ?? "")
          break
        }
        case "reasoning": {
          text += countText(part.text ?? "")
          break
        }
        case "tool-call": {
          tool += countText(`${part.name ?? ""}${stringify(part.input)}`)
          break
        }
        case "tool-result": {
          tool += countToolResult(part.result)
          break
        }
        case "compaction": {
          summaries += countText(part.text ?? "")
          break
        }
        case "media": {
          media += countMedia(part.media?.mediaType)
          break
        }
        default: {
          break
        }
      }
    }
  }

  return { system, tools, tool, text, summaries, media }
}
