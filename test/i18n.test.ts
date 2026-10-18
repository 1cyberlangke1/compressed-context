import { describe, expect, it } from "vitest"

import { en } from "../src/i18n/en.ts"
import { detectLocale, resolveMessages } from "../src/i18n/index.ts"
import { zh } from "../src/i18n/zh.ts"

/** 输入：任意嵌套对象；输出：点分隔的叶子键路径。 */
function leafKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix]
  return Object.entries(value).flatMap(([key, child]) => leafKeys(child, prefix === "" ? key : `${prefix}.${key}`))
}

/** 输入：任意嵌套对象；输出：所有字符串叶子值。 */
function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (typeof value !== "object" || value === null) return []
  return Object.values(value).flatMap((child) => stringValues(child))
}

describe("resolveMessages", () => {
  it("zh* 返回中文", () => {
    expect(resolveMessages("zh-CN").title).toBe("上下文构成")
    expect(resolveMessages("ZH").labels.system).toBe("系统")
  })

  it("其他语言返回英文", () => {
    expect(resolveMessages("en-US").title).toBe("Context breakdown")
    expect(resolveMessages("fr").title).toBe("Context breakdown")
  })

  it("空值走系统 locale 且有兜底", () => {
    const messages = resolveMessages(undefined)
    expect(["上下文构成", "Context breakdown"]).toContain(messages.title)
    expect(detectLocale().length).toBeGreaterThan(0)
  })

  it("两种语言的分类标签齐全", () => {
    for (const locale of ["zh-CN", "en-US"]) {
      expect(Object.keys(resolveMessages(locale).labels).sort()).toEqual([
        "media",
        "summaries",
        "system",
        "text",
        "tool",
        "tools",
      ])
    }
  })
})

describe("语言文件", () => {
  it("中英文键完全一致", () => {
    expect(leafKeys(zh).sort()).toEqual(leafKeys(en).sort())
  })

  it("没有空文案", () => {
    for (const messages of [zh, en]) {
      expect(stringValues(messages).every((value) => value.trim().length > 0)).toBe(true)
    }
  })
})
