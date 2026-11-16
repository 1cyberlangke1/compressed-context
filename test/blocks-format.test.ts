import { describe, expect, it } from "vitest"

import { expandSourceIds, formatSourceSegments } from "../src/shared/blocks.ts"

describe("formatSourceSegments", () => {
  it("纯连续压成单个端点区间", () => {
    expect(formatSourceSegments(["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8"])).toBe("#b1…#b8")
  })

  it("带一个空洞时按连续段分组，不逐条铺开", () => {
    const ids = [
      ...Array.from({ length: 17 }, (_, index) => `b${(34 + index).toString()}`), // b34..b50
      ...Array.from({ length: 26 }, (_, index) => `b${(52 + index).toString()}`), // b52..b77（缺 b51）
    ]
    expect(formatSourceSegments(ids)).toBe("#b34…#b50 + #b52…#b77")
  })

  it("两个孤立点各自成段", () => {
    expect(formatSourceSegments(["b3", "b6"])).toBe("#b3 + #b6")
  })

  it("乱序输入也按数字升序分组", () => {
    expect(formatSourceSegments(["b5", "b3", "b4", "b9"])).toBe("#b3…#b5 + #b9")
  })

  it("单个 id 就是单点", () => {
    expect(formatSourceSegments(["b7"])).toBe("#b7")
  })

  it("空列表返回空串", () => {
    expect(formatSourceSegments([])).toBe("")
  })

  it("非 b<数字> 的 id 原样单独成段", () => {
    expect(formatSourceSegments(["b1", "b2", "custom"])).toBe("#b1…#b2 + #custom")
  })
})

describe("expandSourceIds", () => {
  it("sourceRange 展开成闭区间", () => {
    expect(expandSourceIds({ sourceRange: { first: "b1", last: "b4" } })).toEqual(["b1", "b2", "b3", "b4"])
  })

  it("sourceBlockIds 原样返回", () => {
    expect(expandSourceIds({ sourceBlockIds: ["b3", "b6"] })).toEqual(["b3", "b6"])
  })

  it("两者都没有时返回空", () => {
    expect(expandSourceIds({})).toEqual([])
  })

  it("reverse/invalid range 返回空", () => {
    expect(expandSourceIds({ sourceRange: { first: "b9", last: "b1" } })).toEqual([])
    expect(expandSourceIds({ sourceRange: { first: "x", last: "y" } })).toEqual([])
  })
})
