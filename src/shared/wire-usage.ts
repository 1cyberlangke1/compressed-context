/**
 * 从上游响应报文里提取 usage。
 *
 * 宿主对 `primary` 请求有精确的 `step.ended`；压缩、标题与 `generate` 请求没有
 * 统一的 usage 事件，只能从 `http.response` 的原始响应体里读。本模块只做纯解析：
 * 同时兼容 JSON 响应与 SSE，支持 OpenAI Chat、OpenAI Responses、Anthropic、
 * Gemini 四种常见字段；解析不到就返回 undefined，绝不猜。
 */

import type { StepTokens } from "./cache.ts"

/** 累加器；同一请求的多个分片按字段取最大值，避免重复计数。 */
interface UsageAccumulator {
  input: number
  output: number
  reasoning: number
  read: number
  write: number
}

const EMPTY: UsageAccumulator = { input: 0, output: 0, reasoning: 0, read: 0, write: 0 }

/** 输入：对象 + 键；输出：有限非负数或 undefined。 */
function numberOf(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const item = (value as Record<string, unknown>)[key]
  return typeof item === "number" && Number.isFinite(item) && item >= 0 ? item : undefined
}

/** 输入：对象；输出：对象或 undefined。 */
function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** 输入：单个 usage 形状；输出：映射结果或 undefined。 */
function mapUsage(node: Record<string, unknown>): UsageAccumulator | undefined {
  const prompt = numberOf(node, "prompt_tokens")
  if (prompt !== undefined) {
    const details = objectOf(node["prompt_tokens_details"])
    const cached = numberOf(details, "cached_tokens") ?? numberOf(node, "prompt_cache_hit_tokens") ?? 0
    const completion = numberOf(node, "completion_tokens") ?? 0
    return {
      input: Math.max(0, prompt - cached),
      output: completion,
      reasoning: 0,
      read: cached,
      write: 0,
    }
  }

  const inputTokens = numberOf(node, "input_tokens")
  if (inputTokens !== undefined) {
    const cacheRead = numberOf(node, "cache_read_input_tokens")
    const cacheWrite = numberOf(node, "cache_creation_input_tokens")
    const output = numberOf(node, "output_tokens") ?? 0
    if (cacheRead !== undefined || cacheWrite !== undefined) {
      // Anthropic：input_tokens 本身是非缓存输入。
      return {
        input: inputTokens,
        output,
        reasoning: 0,
        read: cacheRead ?? 0,
        write: cacheWrite ?? 0,
      }
    }
    // OpenAI Responses：input_tokens 包含缓存部分。
    const details = objectOf(node["input_tokens_details"])
    const cached = numberOf(details, "cached_tokens") ?? 0
    return {
      input: Math.max(0, inputTokens - cached),
      output,
      reasoning: 0,
      read: cached,
      write: 0,
    }
  }

  const promptCount = numberOf(node, "promptTokenCount")
  if (promptCount !== undefined) {
    const cached = numberOf(node, "cachedContentTokenCount") ?? 0
    const output = (numberOf(node, "candidatesTokenCount") ?? 0) + (numberOf(node, "thoughtsTokenCount") ?? 0)
    return {
      input: Math.max(0, promptCount - cached),
      output,
      reasoning: 0,
      read: cached,
      write: 0,
    }
  }

  // Anthropic 的 message_delta 只带 output_tokens；输入与缓存来自 message_start。
  const outputOnly = numberOf(node, "output_tokens")
  if (outputOnly !== undefined) {
    return { input: 0, output: outputOnly, reasoning: 0, read: 0, write: 0 }
  }
  return undefined
}

/** 输入：累加器 + 新映射；输出：逐字段取最大值后的累加器。 */
function mergeMax(target: UsageAccumulator, next: UsageAccumulator): UsageAccumulator {
  return {
    input: Math.max(target.input, next.input),
    output: Math.max(target.output, next.output),
    reasoning: Math.max(target.reasoning, next.reasoning),
    read: Math.max(target.read, next.read),
    write: Math.max(target.write, next.write),
  }
}

/** 输入：任意 JSON 节点 + 累加器；输出：遍历后的累加器。预期：深度受限，避免恶意嵌套。 */
function walk(node: unknown, acc: UsageAccumulator, depth: number): UsageAccumulator {
  if (depth > 10) return acc
  if (Array.isArray(node)) {
    const items: readonly unknown[] = node
    return items.reduce<UsageAccumulator>((next, item) => walk(item, next, depth + 1), acc)
  }
  const record = objectOf(node)
  if (record === undefined) return acc
  const mapped = mapUsage(record)
  const withUsage = mapped === undefined ? acc : mergeMax(acc, mapped)
  return Object.values(record).reduce<UsageAccumulator>((next, item) => walk(item, next, depth + 1), withUsage)
}

/** 输入：原始响应文本；输出：要遍历的 JSON 根节点列表。预期：兼容裸 JSON 与 SSE。 */
function rootsOf(text: string): readonly unknown[] {
  const trimmed = text.trim()
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return [JSON.parse(trimmed)]
    } catch {
      // 顶层不是单个 JSON：继续按行扫描。
    }
  }
  const roots: unknown[] = []
  for (const line of text.split(/\r?\n/)) {
    const candidate = line.startsWith("data:") ? line.slice(5).trim() : line.trim()
    if (!candidate.startsWith("{") && !candidate.startsWith("[")) continue
    try {
      roots.push(JSON.parse(candidate))
    } catch {
      // 单个分片损坏不影响其它分片。
    }
  }
  return roots
}

/** 输入：原始响应文本；输出：这次请求的 usage；解析不到返回 undefined。 */
export function usageFromWireBody(text: string): StepTokens | undefined {
  const acc = rootsOf(text).reduce<UsageAccumulator>((next, root) => walk(root, next, 0), EMPTY)
  const total = acc.input + acc.output + acc.read + acc.write
  if (total <= 0) return undefined
  return {
    input: acc.input,
    output: acc.output,
    reasoning: acc.reasoning,
    cache: { read: acc.read, write: acc.write },
  }
}
