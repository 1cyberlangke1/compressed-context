import { describe, expect, it } from "vitest"

import { en } from "../src/i18n/en.ts"
import { resolveMessages } from "../src/i18n/index.ts"
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
  it("zh* 用中文，其余用英文", () => {
    expect(resolveMessages("zh-CN").title).toBe("上下文构成")
    expect(resolveMessages("en-US").title).toBe("Context breakdown")
    expect(resolveMessages("fr").title).toBe("Context breakdown")
  })
})

describe("语言文件", () => {
  it("中英文键一致且没有空文案", () => {
    expect(leafKeys(zh).sort()).toEqual(leafKeys(en).sort())
    for (const messages of [zh, en]) {
      expect(stringValues(messages).every((value) => value.trim().length > 0)).toBe(true)
    }
  })
})
