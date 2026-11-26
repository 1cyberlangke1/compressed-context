import { describe, expect, it } from "vitest"

import { diffLines, splitLines } from "../src/shared/line-diff.ts"

/** 输入：文本；输出：左右两侧的文本数组；便于断言对齐结果。 */
function sides(left: string, right: string): {
  readonly left: readonly (string | undefined)[]
  readonly right: readonly (string | undefined)[]
  readonly kinds: readonly string[]
} {
  const rows = diffLines(left, right)
  return {
    left: rows.map((row) => row.left?.text),
    right: rows.map((row) => row.right?.text),
    kinds: rows.map((row) => row.kind),
  }
}

describe("splitLines", () => {
  it("保留空行并去掉行尾回车", () => {
    expect(splitLines("a\r\n\r\nb")).toEqual(["a", "", "b"])
  })

  it("空文本仍然有一行", () => {
    expect(splitLines("")).toEqual([""])
  })
})

describe("diffLines", () => {
  it("完全相同时全部是 same，行号从 1 开始", () => {
    const rows = diffLines("a\nb", "a\nb")
    expect(rows.map((row) => row.kind)).toEqual(["same", "same"])
    expect(rows.map((row) => row.left?.no)).toEqual([1, 2])
    expect(rows.map((row) => row.right?.no)).toEqual([1, 2])
  })

  it("中间插入一行时只有右侧多一行，其余仍是 same", () => {
    const got = sides("a\nc", "a\nb\nc")
    expect(got.left).toEqual(["a", undefined, "c"])
    expect(got.right).toEqual(["a", "b", "c"])
    expect(got.kinds).toEqual(["same", "change", "same"])
  })

  it("删除一行时只有左侧多一行", () => {
    const got = sides("a\nb\nc", "a\nc")
    expect(got.left).toEqual(["a", "b", "c"])
    expect(got.right).toEqual(["a", undefined, "c"])
  })

  it("修改的行左右配对成一行 change", () => {
    const got = sides("a\nold\nc", "a\nnew\nc")
    expect(got.left).toEqual(["a", "old", "c"])
    expect(got.right).toEqual(["a", "new", "c"])
    expect(got.kinds).toEqual(["same", "change", "same"])
  })

  it("连续多行改写时逐行配对，行号各自递增", () => {
    const rows = diffLines("a\nx\ny\nz", "a\np\nq")
    expect(rows.map((row) => row.kind)).toEqual(["same", "change", "change", "change"])
    expect(rows.slice(1).map((row) => row.left?.no)).toEqual([2, 3, 4])
    expect(rows.slice(1).map((row) => row.right?.no)).toEqual([2, 3, undefined])
  })

  it("空行参与对齐，不被吞掉", () => {
    const got = sides("a\n\nb", "a\n\n\nb")
    expect(got.left).toEqual(["a", "", undefined, "b"])
    expect(got.right).toEqual(["a", "", "", "b"])
  })

  it("中间段过大时按位置硬配对，仍然给出全部行", () => {
    const left = Array.from({ length: 2_100 }, (_, index) => `left-${index.toString()}`)
    const right = Array.from({ length: 2_100 }, (_, index) => `right-${index.toString()}`)
    const rows = diffLines(left.join("\n"), right.join("\n"))
    expect(rows).toHaveLength(2_100)
    expect(rows[0]?.left?.text).toBe("left-0")
    expect(rows[0]?.right?.text).toBe("right-0")
    expect(rows[0]?.kind).toBe("change")
    expect(rows[2_099]?.left?.no).toBe(2_100)
  })

  it("只在尾部追加时前缀全部是 same", () => {
    const rows = diffLines("a\nb", "a\nb\nc")
    expect(rows.map((row) => row.kind)).toEqual(["same", "same", "change"])
    expect(rows[2]?.left).toBeUndefined()
    expect(rows[2]?.right?.text).toBe("c")
  })
})
