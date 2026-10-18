import { describe, expect, it } from "vitest"

import { detectLocale, resolveMessages } from "../src/i18n/index.ts"

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
