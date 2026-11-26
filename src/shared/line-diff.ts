/**
 * 行级差异：把两段文本按行对齐，供并排对比视图渲染。
 *
 * 只做纯计算，不依赖终端库。对齐规则：
 * 1. 先吃掉公共前缀和公共后缀，中间段才做 LCS。
 * 2. 中间段过大时按位置硬配对，避免 O(n*m) 撑爆内存。
 * 3. 一次连续的新增/删除块里按顺序配对，左右同行展示。
 */

/** 对齐后的一侧；行号从 1 开始。 */
export interface LineDiffLine {
  readonly no: number
  readonly text: string
}

/** 对齐后的一行；缺左侧或右侧表示该行只在一侧出现。 */
export interface LineDiffRow {
  readonly left?: LineDiffLine
  readonly right?: LineDiffLine
  readonly kind: "same" | "change"
}

/** 中间段 LCS 允许的最大格子数；超过就按位置配对。 */
const MAX_LCS_CELLS = 4_000_000

/** 输入：文本；输出：按行拆开的数组；保留空行，行尾 `\r` 去掉。 */
export function splitLines(text: string): readonly string[] {
  return text.split(/\r?\n/)
}

/**
 * 输入：两段文本。
 * 输出：按行对齐的差异行；相同行 kind=same，其余 kind=change。
 * 预期：相同行在左右两侧都有且行号各自递增；只在左侧出现的行 right 缺省，反之亦然。
 */
export function diffLines(leftText: string, rightText: string): readonly LineDiffRow[] {
  const left = splitLines(leftText)
  const right = splitLines(rightText)
  let start = 0
  const limit = Math.min(left.length, right.length)
  while (start < limit && left[start] === right[start]) start += 1
  let endLeft = left.length
  let endRight = right.length
  while (endLeft > start && endRight > start && left[endLeft - 1] === right[endRight - 1]) {
    endLeft -= 1
    endRight -= 1
  }

  const rows: LineDiffRow[] = []
  for (let index = 0; index < start; index += 1) {
    rows.push(sameRow(index + 1, index + 1, left[index] ?? ""))
  }
  rows.push(...diffMiddle(left.slice(start, endLeft), right.slice(start, endRight), start, start))
  const tail = left.length - endLeft
  for (let index = 0; index < tail; index += 1) {
    rows.push(sameRow(endLeft + index + 1, endRight + index + 1, left[endLeft + index] ?? ""))
  }
  return rows
}

/** 输入：两侧行 + 行号偏移；输出：中间段的差异行。 */
function diffMiddle(
  left: readonly string[],
  right: readonly string[],
  leftOffset: number,
  rightOffset: number,
): readonly LineDiffRow[] {
  if (left.length === 0) {
    return right.map((text, index) => changeRow(undefined, { no: rightOffset + index + 1, text }))
  }
  if (right.length === 0) {
    return left.map((text, index) => changeRow({ no: leftOffset + index + 1, text }, undefined))
  }
  if (left.length * right.length > MAX_LCS_CELLS) return pairByIndex(left, right, leftOffset, rightOffset)
  return pairOps(lcsOps(left, right), left, right, leftOffset, rightOffset)
}

/** LCS 回溯用的一步。 */
type Op =
  | { readonly kind: "same"; readonly left: number; readonly right: number }
  | { readonly kind: "left"; readonly left: number }
  | { readonly kind: "right"; readonly right: number }

/**
 * 输入：两侧行。
 * 输出：保持顺序的相同/删除/新增操作序列。
 * 预期：suffix DP 从尾向前填，回溯从头部开始，天然得到正序结果。
 */
function lcsOps(left: readonly string[], right: readonly string[]): readonly Op[] {
  const cols = right.length + 1
  const dp = new Int32Array((left.length + 1) * cols)
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      const here = i * cols + j
      if (left[i] === right[j]) {
        dp[here] = (dp[(i + 1) * cols + j + 1] ?? 0) + 1
        continue
      }
      const skipLeft = dp[(i + 1) * cols + j] ?? 0
      const skipRight = dp[i * cols + j + 1] ?? 0
      dp[here] = skipLeft >= skipRight ? skipLeft : skipRight
    }
  }

  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      ops.push({ kind: "same", left: i, right: j })
      i += 1
      j += 1
      continue
    }
    const skipLeft = dp[(i + 1) * cols + j] ?? 0
    const skipRight = dp[i * cols + j + 1] ?? 0
    if (skipLeft >= skipRight) {
      ops.push({ kind: "left", left: i })
      i += 1
    } else {
      ops.push({ kind: "right", right: j })
      j += 1
    }
  }
  while (i < left.length) {
    ops.push({ kind: "left", left: i })
    i += 1
  }
  while (j < right.length) {
    ops.push({ kind: "right", right: j })
    j += 1
  }
  return ops
}

/** 输入：差异操作序列 + 两侧行 + 行号偏移；输出：左右配对后的行。 */
function pairOps(
  ops: readonly Op[],
  left: readonly string[],
  right: readonly string[],
  leftOffset: number,
  rightOffset: number,
): readonly LineDiffRow[] {
  const rows: LineDiffRow[] = []
  let pendingLeft: number[] = []
  let pendingRight: number[] = []

  /** 输入：无；输出：无；预期：把待配对的两侧行按顺序合成 change 行。 */
  const flush = (): void => {
    const count = Math.max(pendingLeft.length, pendingRight.length)
    for (let index = 0; index < count; index += 1) {
      const leftIndex = pendingLeft[index]
      const rightIndex = pendingRight[index]
      rows.push(
        changeRow(
          leftIndex === undefined ? undefined : { no: leftOffset + leftIndex + 1, text: left[leftIndex] ?? "" },
          rightIndex === undefined ? undefined : { no: rightOffset + rightIndex + 1, text: right[rightIndex] ?? "" },
        ),
      )
    }
    pendingLeft = []
    pendingRight = []
  }

  for (const op of ops) {
    if (op.kind === "same") {
      flush()
      rows.push(sameRow(leftOffset + op.left + 1, rightOffset + op.right + 1, left[op.left] ?? ""))
    } else if (op.kind === "left") {
      pendingLeft.push(op.left)
    } else {
      pendingRight.push(op.right)
    }
  }
  flush()
  return rows
}

/** 输入：两侧行 + 偏移；输出：按位置硬配对的行；用于超大中间段。 */
function pairByIndex(
  left: readonly string[],
  right: readonly string[],
  leftOffset: number,
  rightOffset: number,
): readonly LineDiffRow[] {
  const rows: LineDiffRow[] = []
  const count = Math.max(left.length, right.length)
  for (let index = 0; index < count; index += 1) {
    const leftText = left[index]
    const rightText = right[index]
    const leftLine = leftText === undefined ? undefined : { no: leftOffset + index + 1, text: leftText }
    const rightLine = rightText === undefined ? undefined : { no: rightOffset + index + 1, text: rightText }
    if (leftText !== undefined && leftText === rightText) {
      rows.push(sameRow(leftOffset + index + 1, rightOffset + index + 1, leftText))
      continue
    }
    rows.push(changeRow(leftLine, rightLine))
  }
  return rows
}

/** 输入：两侧行号 + 文本；输出：相同行。 */
function sameRow(leftNo: number, rightNo: number, text: string): LineDiffRow {
  return { left: { no: leftNo, text }, right: { no: rightNo, text }, kind: "same" }
}

/** 输入：两侧行（可缺）；输出：变化行。 */
function changeRow(left: LineDiffLine | undefined, right: LineDiffLine | undefined): LineDiffRow {
  return {
    ...(left === undefined ? {} : { left }),
    ...(right === undefined ? {} : { right }),
    kind: "change",
  }
}
