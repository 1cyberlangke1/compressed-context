import type { CacheDropBreak } from "../../shared/cache-drops.ts"

/** 输入：断点；输出：`system[0] +41` 这样的定位文本；无断点时为空串。 */
export function segmentLabel(breakPoint: CacheDropBreak | undefined): string {
  if (breakPoint === undefined) return ""
  return breakPoint.offset > 0 ? `${breakPoint.segment} +${breakPoint.offset.toString()}` : breakPoint.segment
}

/**
 * 输入：断点；输出：三段字母前缀 + 下标（`mes[62]`、`sys`）。
 * 预期：侧栏很窄时只省略后面的部分，不挤压时间/跌幅/类型列。
 */
export function shortSegment(breakPoint: CacheDropBreak | undefined): string {
  if (breakPoint === undefined) return ""
  const match = /^(.*)\[(\d+)\]$/.exec(breakPoint.segment)
  const base = match?.[1] ?? breakPoint.segment
  const index = match?.[2]
  const short = Array.from(base).slice(0, 3).join("")
  return index === undefined ? short : `${short}[${index}]`
}

/** 输入：毫秒时间戳；输出：`HH:MM`。预期：只显示本地时钟，跨天信息由面板顺序承担。 */
export function timeLabel(at: number): string {
  const date = new Date(at)
  return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`
}

/** 两侧原文按公共前后缀拆开；中间不同的一段分别高亮。 */
export interface ExcerptSplit {
  readonly prefix: string
  readonly was: string
  readonly now: string
  readonly suffix: string
}

/**
 * 输入：断点里的 before/after 摘录。
 * 输出：公共前缀、两段差异、公共后缀。
 * 预期：按 Unicode 码点比较，emoji 不会被拆成两半。
 */
export function splitExcerpt(breakPoint: CacheDropBreak): ExcerptSplit {
  const before = Array.from(breakPoint.before)
  const after = Array.from(breakPoint.after)
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1
  }
  return {
    prefix: before.slice(0, prefix).join(""),
    was: before.slice(prefix, before.length - suffix).join(""),
    now: after.slice(prefix, after.length - suffix).join(""),
    suffix: before.slice(before.length - suffix).join(""),
  }
}
