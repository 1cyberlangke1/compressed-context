import { stringify, toolInput, toolResult, toolResultText } from "../shared/parts.ts"
import type { ContentPartLike, MessageLike } from "./select.ts"

/** 单条工具输出最多保留的字符数。 */
const TOOL_RESULT_MAX = 2_000
/** 工具调用参数最多保留的字符数。 */
const TOOL_INPUT_MAX = 500
/** 整份 transcript 的字符上限，防止侧调用自身溢出。 */
export const TRANSCRIPT_MAX = 200_000

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…[truncated]`
}

function renderMessage(message: MessageLike): string {
  const lines: string[] = []
  if (typeof message.text === "string" && message.text.length > 0) {
    lines.push(message.role === "user" ? `[User]\n${message.text}` : message.text)
  }
  const content: readonly ContentPartLike[] = Array.isArray(message.content)
    ? message.content
    : []
  for (const part of content) {
    if (part.type === "text") {
      const text = part.text ?? ""
      if (text.length > 0) lines.push(message.role === "user" ? `[User]\n${text}` : text)
      continue
    }
    if (part.type === "tool") {
      lines.push(`[Tool call ${part.name ?? "?"}] ${truncate(stringify(toolInput(part)), TOOL_INPUT_MAX)}`)
      lines.push(`[Tool result ${part.name ?? "?"}] ${truncate(toolResultText(toolResult(part)), TOOL_RESULT_MAX)}`)
      continue
    }
    if (part.type === "tool-call") {
      lines.push(`[Tool call ${part.name ?? "?"}] ${truncate(stringify(toolInput(part)), TOOL_INPUT_MAX)}`)
      continue
    }
    if (part.type === "tool-result") {
      lines.push(`[Tool result ${part.name ?? "?"}] ${truncate(toolResultText(toolResult(part)), TOOL_RESULT_MAX)}`)
    }
  }
  return lines.join("\n")
}

/**
 * 输入：可压缩消息。
 * 输出：给侧调用使用的纯文本 transcript。
 * 预期：跳过 reasoning/media；工具输出截断；整体超限时丢弃最老的消息。
 */
export function buildTranscript(messages: readonly MessageLike[]): string {
  const rendered = messages.map(renderMessage).filter((text) => text.length > 0)
  let total = rendered.reduce((sum, text) => sum + text.length + 2, 0)
  let start = 0
  while (total > TRANSCRIPT_MAX && start < rendered.length - 1) {
    const item = rendered[start]
    if (item === undefined) break
    total -= item.length + 2
    start += 1
  }
  const kept = rendered.slice(start)
  const prefix = start > 0 ? `[older messages omitted: ${start.toString()}]\n\n` : ""
  return prefix + kept.join("\n\n")
}
