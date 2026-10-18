import { en } from "./en.ts"
import type { Messages } from "./types.ts"
import { zh } from "./zh.ts"

export type { Messages }

/**
 * 输入：locale 字符串（可为空）。
 * 输出：对应语言的消息表。
 * 预期：`zh*` 用中文，其余一律英文；空值回退到系统 locale。
 */
export function resolveMessages(locale: string | undefined): Messages {
  const value = (locale ?? detectLocale()).toLowerCase()
  return value.startsWith("zh") ? zh : en
}

/**
 * 输入：无。
 * 输出：系统 locale。
 * 预期：运行时拿不到时回退 `en`，保证始终有文案。
 */
export function detectLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return "en"
  }
}
