import { describe, expect, it } from "vitest"

import { formatTokens } from "../src/format.ts"
import {
  createStats,
  mergeMetadata,
  parseStats,
  PUBLISH_MIN_DELTA,
  scaleCategories,
  shouldPublish,
  STATS_KEY,
  type ContextStats,
} from "../src/stats.ts"

const categories = {
  system: 1_000,
  tools: 500,
  tool: 2_000,
  text: 1_500,
  summaries: 0,
  media: 0,
}

describe("createStats", () => {
  it("合计等于各分类之和", () => {
    const stats = createStats(categories, 123)
    expect(stats.estimatedTotal).toBe(5_000)
    expect(stats.at).toBe(123)
  })
})

describe("parseStats", () => {
  it("能还原 createStats 的结果", () => {
    const stats = createStats(categories, 123)
    expect(parseStats(stats)).toEqual(stats)
  })

  it("拒绝非对象、缺字段、负数", () => {
    expect(parseStats(undefined)).toBeUndefined()
    expect(parseStats(null)).toBeUndefined()
    expect(parseStats("nope")).toBeUndefined()
    expect(parseStats({})).toBeUndefined()
    expect(parseStats({ ...createStats(categories, 1), system: -1 })).toBeUndefined()
  })
})

describe("shouldPublish", () => {
  it("首次一定发布", () => {
    expect(shouldPublish(undefined, createStats(categories, 1))).toBe(true)
  })

  it("变化小于阈值不发布", () => {
    const previous = createStats(categories, 1)
    const next = createStats({ ...categories, text: categories.text + 10 }, 2)
    expect(shouldPublish(previous, next)).toBe(false)
  })

  it("合计变化达到阈值发布", () => {
    const previous = createStats(categories, 1)
    const next = createStats({ ...categories, text: categories.text + PUBLISH_MIN_DELTA }, 2)
    expect(shouldPublish(previous, next)).toBe(true)
  })

  it("单类变化达到阈值也发布", () => {
    const previous = createStats(categories, 1)
    const next = createStats(
      { ...categories, text: categories.text - PUBLISH_MIN_DELTA, tool: categories.tool + PUBLISH_MIN_DELTA },
      2,
    )
    expect(shouldPublish(previous, next)).toBe(true)
  })
})

describe("mergeMetadata", () => {
  it("保留其他键并替换统计键", () => {
    const stats = createStats(categories, 1)
    const merged = mergeMetadata({ other: "keep", [STATS_KEY]: { stale: true } }, stats)
    expect(merged["other"]).toBe("keep")
    expect(merged[STATS_KEY]).toMatchObject({ system: 1_000, estimatedTotal: 5_000 })
  })

  it("没有旧 metadata 时也能构造", () => {
    const merged = mergeMetadata(undefined, createStats(categories, 1))
    expect(merged[STATS_KEY]).toBeDefined()
  })
})

describe("scaleCategories", () => {
  it("按真实总量缩放，百分比加总接近 100", () => {
    const stats = createStats(categories, 1)
    const rows = scaleCategories(stats, 12_000)
    const total = rows.reduce((sum, row) => sum + row.value, 0)
    expect(total).toBe(12_000)
    expect(rows.find((row) => row.key === "tool")?.value).toBe(4_800)
    expect(rows.reduce((sum, row) => sum + row.pct, 0)).toBeGreaterThanOrEqual(99)
  })

  it("真实总量缺失时保持原值", () => {
    const stats = createStats(categories, 1)
    const rows = scaleCategories(stats, 0)
    expect(rows.find((row) => row.key === "system")?.value).toBe(1_000)
  })

  it("估算为 0 时全部为 0", () => {
    const stats = createStats(
      { system: 0, tools: 0, tool: 0, text: 0, summaries: 0, media: 0 },
      1,
    )
    const rows = scaleCategories(stats, 10_000)
    expect(rows.every((row) => row.value === 0 && row.pct === 0)).toBe(true)
  })
})

describe("formatTokens", () => {
  it("按阈值切换单位", () => {
    expect(formatTokens(999)).toBe("999")
    expect(formatTokens(1_500)).toBe("1.5k")
    expect(formatTokens(15_000)).toBe("15k")
    expect(formatTokens(1_500_000)).toBe("1.5M")
    expect(formatTokens(15_000_000)).toBe("15M")
  })
})

describe("ContextStats 类型", () => {
  it("可以从 createStats 推导", () => {
    const stats: ContextStats = createStats(categories, 1)
    expect(stats.system).toBe(1_000)
  })
})
