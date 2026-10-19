#!/usr/bin/env node
/**
 * 输入：两个请求体 JSON 文件（before.json / after.json）。
 * 输出：strict 追加 / messages 尾部追加 / 中间改写，并给出第一个分歧点。
 * 预期：压缩请求只应在尾部追加指令；中间改写会让前缀缓存失效。
 *
 * 用法：
 *   node scripts/cache-check.mjs before.json after.json
 *
 * 退出码：
 *   0 = 尾部追加（缓存前缀仍可复用）
 *   1 = 中间改写或无法解析（缓存前缀失效）
 */

import { readFile } from "node:fs/promises"

/** 输入：两个值；输出：稳定 JSON 字符串。 */
function stable(value) {
  return JSON.stringify(value)
}

/** 输入：两个请求体字符串；输出：分类结果。 */
function compare(before, after) {
  if (after.startsWith(before)) {
    return { kind: "strict", detail: "after 以 before 的完整字节为前缀" }
  }

  let a
  let b
  try {
    a = JSON.parse(before)
    b = JSON.parse(after)
  } catch {
    return { kind: "rewrite", detail: "不是严格字节追加，且 JSON 解析失败" }
  }

  const am = Array.isArray(a?.messages) ? a.messages : undefined
  const bm = Array.isArray(b?.messages) ? b.messages : undefined
  if (am === undefined || bm === undefined) {
    return { kind: "rewrite", detail: "请求体没有 messages 数组" }
  }

  const shared = Math.min(am.length, bm.length)
  for (let index = 0; index < shared; index += 1) {
    if (stable(am[index]) !== stable(bm[index])) {
      return {
        kind: "rewrite",
        detail: `第 ${index.toString()} 条 message 被改写（before ${am.length} 条，after ${bm.length} 条）`,
      }
    }
  }

  if (bm.length > am.length) {
    return {
      kind: "json-tail",
      detail: `前 ${am.length} 条 message 完全一致，after 尾部新增 ${(bm.length - am.length).toString()} 条`,
    }
  }

  if (bm.length === am.length) {
    return { kind: "json-tail", detail: "messages 完全一致，只有其他字段变化" }
  }

  return {
    kind: "rewrite",
    detail: `after 的 messages 更短（before ${am.length} 条，after ${bm.length} 条）`,
  }
}

const [beforePath, afterPath] = process.argv.slice(2)
if (beforePath === undefined || afterPath === undefined) {
  console.error("用法: node scripts/cache-check.mjs before.json after.json")
  process.exit(1)
}

const [before, after] = await Promise.all([readFile(beforePath, "utf8"), readFile(afterPath, "utf8")])
const result = compare(before, after)
console.log(`${result.kind}: ${result.detail}`)
process.exit(result.kind === "rewrite" ? 1 : 0)
