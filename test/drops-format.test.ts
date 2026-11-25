import { describe, expect, it } from "vitest"

import { segmentLabel, shortSegment, splitExcerpt } from "../src/tui/panel/drops-format.ts"

/** 输入：段标识 + 两侧摘录；输出：断点对象。 */
function point(segment: string, before = "AAAA", after = "AABA", offset = 1) {
  return { segment, offset, before, after }
}

describe("shortSegment", () => {
  it("数组段保留三字母前缀和下标", () => {
    expect(shortSegment(point("messages[62]"))).toBe("mes[62]")
    expect(shortSegment(point("tools[0]"))).toBe("too[0]")
  })

  it("标量段只留三字母前缀", () => {
    expect(shortSegment(point("system"))).toBe("sys")
    expect(shortSegment(point("temperature"))).toBe("tem")
  })

  it("无断点返回空串", () => {
    expect(shortSegment(undefined)).toBe("")
  })
})

describe("segmentLabel", () => {
  it("偏移大于零时带上加号", () => {
    expect(segmentLabel(point("messages[1]", "AAAA", "AABA", 3))).toBe("messages[1] +3")
  })

  it("无断点返回空串", () => {
    expect(segmentLabel(undefined)).toBe("")
  })
})

describe("splitExcerpt", () => {
  it("按公共前后缀拆开两侧差异", () => {
    expect(splitExcerpt(point("x", "AAAA", "AABA", 1))).toEqual({
      prefix: "AA",
      was: "A",
      now: "B",
      suffix: "A",
    })
  })
})
