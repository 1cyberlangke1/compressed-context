/**
 * 从上游响应报文里提取 usage。
 *
 * 宿主对 `primary` 请求有精确的 `step.ended`；压缩、标题与 `generate` 请求没有
 * 统一的 usage 事件，只能从 `http.response` 的原始响应体里读。
 *
 * 这里不按厂商分支，而是通用地扫描 JSON 里的数值字段：
 * - 含 `cached` / `cache_read` / `cache_hit` → 命中缓存
 * - 含 `cache_creation` / `cache_write` → 写入缓存
 * - 含 `prompt` 或 `input_tokens` → 输入
 * - 含 `completion` / `output_tokens` / `candidates` / `thought` → 输出
 * 同一请求的多个分片按字段取最大值；输入再按「总输入 - 缓存读 - 缓存写」折算。
 * 解析不到就返回 undefined，绝不猜。
 */

import type { StepTokens } from "./cache.ts"

/** 单个对象的数值字段归类结果。 */
interface ObjectUsage {
  readonly totalInput?: number
  readonly plainInput?: number
  readonly hasCacheHint: boolean
  readonly output: number
  readonly read: number
  readonly write: number
}

const EMPTY: ObjectUsage = { hasCacheHint: false, output: 0, read: 0, write: 0 }

/** 输入：键名；输出：小写、去掉分隔符后的形式，便于通用匹配。 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "")
}

/** 输入：任意值；输出：普通对象或 undefined。 */
function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** 输入：普通对象；输出：该对象里能识别出的 usage 数值。 */
function classify(record: Record<string, unknown>): ObjectUsage {
  let totalInput: number | undefined
  let plainInput: number | undefined
  let output = 0
  let read = 0
  let write = 0
  let hasCacheHint = false

  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue
    const name = normalizeKey(key)
    if (name.includes("cached") || name.includes("cacheread") || name.includes("cachehit")) {
      read = Math.max(read, value)
      hasCacheHint = true
      continue
    }
    if (name.includes("cachecreation") || name.includes("cachewrite")) {
      write = Math.max(write, value)
      hasCacheHint = true
      continue
    }
    if (name.includes("reasoning")) continue
    if (name.includes("prompt")) {
      totalInput = Math.max(totalInput ?? 0, value)
      continue
    }
    if (name === "inputtokens") {
      plainInput = Math.max(plainInput ?? 0, value)
      continue
    }
    if (
      name.includes("completion") ||
      name.includes("outputtokens") ||
      name.includes("candidates") ||
      name.includes("thought")
    ) {
      output += value
    }
  }

  // 同一对象同时有 input_tokens 与缓存字段：input_tokens 是非缓存输入。
  if (plainInput !== undefined && hasCacheHint) {
    return { plainInput, hasCacheHint, output, read, write }
  }
  const input = totalInput ?? plainInput
  return {
    ...(input === undefined ? {} : { totalInput: input }),
    hasCacheHint,
    output,
    read,
    write,
  }
}

/** 输入：累加器 + 新对象；输出：逐字段取最大值。 */
function mergeMax(target: ObjectUsage, next: ObjectUsage): ObjectUsage {
  return {
    ...(target.totalInput === undefined && next.totalInput === undefined
      ? {}
      : { totalInput: Math.max(target.totalInput ?? 0, next.totalInput ?? 0) }),
    ...(target.plainInput === undefined && next.plainInput === undefined
      ? {}
      : { plainInput: Math.max(target.plainInput ?? 0, next.plainInput ?? 0) }),
    hasCacheHint: target.hasCacheHint || next.hasCacheHint,
    output: Math.max(target.output, next.output),
    read: Math.max(target.read, next.read),
    write: Math.max(target.write, next.write),
  }
}

/** 输入：任意 JSON 节点 + 累加器；输出：遍历后的累加器。预期：深度受限，避免恶意嵌套。 */
function walk(node: unknown, acc: ObjectUsage, depth: number): ObjectUsage {
  if (depth > 10) return acc
  if (Array.isArray(node)) {
    const items: readonly unknown[] = node
    return items.reduce<ObjectUsage>((next, item) => walk(item, next, depth + 1), acc)
  }
  const record = objectOf(node)
  if (record === undefined) return acc
  const withUsage = mergeMax(acc, classify(record))
  return Object.values(record).reduce<ObjectUsage>((next, item) => walk(item, next, depth + 1), withUsage)
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
  const acc = rootsOf(text).reduce<ObjectUsage>((next, root) => walk(root, next, 0), EMPTY)
  const fromTotal = Math.max(0, (acc.totalInput ?? 0) - acc.read - acc.write)
  const input = Math.max(fromTotal, acc.plainInput ?? 0)
  const total = input + acc.output + acc.read + acc.write
  if (total <= 0) return undefined
  return {
    input,
    output: acc.output,
    reasoning: 0,
    cache: { read: acc.read, write: acc.write },
  }
}
