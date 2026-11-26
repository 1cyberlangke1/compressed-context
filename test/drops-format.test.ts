import { describe, expect, it } from "vitest"

import {
  groupOutline,
  looseFormatJson,
  prettyJsonLines,
  prettyValueLines,
  segmentLabel,
  shortSegment,
  splitExcerpt,
} from "../src/tui/panel/drops-format.ts"

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

describe("groupOutline", () => {
  it("数组字段收成父节点，标量字段是单叶", () => {
    const groups = groupOutline([
      { key: "system", chars: 12 },
      { key: "messages[0]", chars: 30 },
      { key: "messages[1]", chars: 40 },
    ])
    expect(groups).toEqual([
      { name: "system", array: false, leaves: [{ label: "", chars: 12 }] },
      {
        name: "messages",
        array: true,
        leaves: [
          { label: "[0]", chars: 30 },
          { label: "[1]", chars: 40 },
        ],
      },
    ])
  })
})

describe("looseFormatJson", () => {
  it("把紧凑 JSON 展开成缩进行", () => {
    expect(looseFormatJson('{"a":1,"b":[2,3]}').split("\n")).toEqual([
      "{",
      '  "a": 1,',
      '  "b": [',
      "    2,",
      "    3",
      "  ]",
      "}",
    ])
  })

  it("被截断的尾部也照样缩进，不抛异常", () => {
    const lines = looseFormatJson('{"messages":[{"role":"user","content":"half').split("\n")
    expect(lines[0]).toBe("{")
    expect(lines[1]).toBe('  "messages": [')
    expect(lines[2]).toBe("    {")
  })

  it("字符串里的括号和逗号不换行", () => {
    const lines = looseFormatJson('{"a":"x,{y}"}').split("\n")
    expect(lines).toEqual(["{", '  "a": "x,{y}"', "}"])
  })
})

describe("prettyJsonLines", () => {
  it("合法 JSON 按值格式化，字符串直接显示原文", () => {
    expect(prettyJsonLines('{"role":"user","content":"hi"}')).toEqual([
      "{",
      '  "role": "user",',
      '  "content": "hi"',
      "}",
    ])
    expect(prettyJsonLines('"hi"')).toEqual(["hi"])
  })

  it("值里套 JSON 字符串时不再解析", () => {
    expect(prettyValueLines('{"path":"x"}')).toEqual(['{"path":"x"}'])
    expect(prettyJsonLines('"{\\"path\\":\\"x\\"}"')).toEqual(['{"path":"x"}'])
  })

  it("解析失败时退回宽松格式化", () => {
    expect(prettyJsonLines('{"a":1').slice(0, 2)).toEqual(["{", '  "a": 1'])
  })

  it("undefined 返回空数组", () => {
    expect(prettyJsonLines(undefined)).toEqual([])
  })
})
