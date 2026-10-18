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
} from "../src/stats.ts"

const categories = {
  system: 1_000,
  tools: 500,
  tool: 2_000,
  text: 1_500,
  recent: 0,
  summaries: 0,
  media: 0,
}

describe("createStats / parseStats", () => {
  it("合计等于各分类之和，且能原样解析", () => {
    const stats = createStats(categories, 123)
    expect(stats.estimatedTotal).toBe(5_000)
    expect(parseStats(stats)).toEqual(stats)
  })

  it("拒绝非对象、缺字段与负数", () => {
    expect(parseStats(undefined)).toBeUndefined()
    expect(parseStats("nope")).toBeUndefined()
    expect(parseStats({})).toBeUndefined()
    expect(parseStats({ ...createStats(categories, 1), system: -1 })).toBeUndefined()
  })

  it("旧统计缺少 recent 时按 0 兼容", () => {
    const legacy: Record<string, unknown> = { ...createStats(categories, 1) }
    delete legacy["recent"]
    expect(parseStats(legacy)?.recent).toBe(0)
  })
})

describe("shouldPublish", () => {
  it("首次发布，小变化不发布", () => {
    expect(shouldPublish(undefined, createStats(categories, 1))).toBe(true)
    const previous = createStats(categories, 1)
    const next = createStats({ ...categories, text: categories.text + 10 }, 2)
    expect(shouldPublish(previous, next)).toBe(false)
  })

  it("合计或单类变化达到阈值时发布", () => {
    const previous = createStats(categories, 1)
    expect(shouldPublish(previous, createStats({ ...categories, text: categories.text + PUBLISH_MIN_DELTA }, 2))).toBe(
      true,
    )
    expect(
      shouldPublish(
        previous,
        createStats(
          { ...categories, text: categories.text - PUBLISH_MIN_DELTA, tool: categories.tool + PUBLISH_MIN_DELTA },
          2,
        ),
      ),
    ).toBe(true)
  })
})

describe("mergeMetadata", () => {
  it("保留其他键并替换统计键", () => {
    const merged = mergeMetadata({ other: "keep", [STATS_KEY]: { stale: true } }, createStats(categories, 1))
    expect(merged["other"]).toBe("keep")
    expect(merged[STATS_KEY]).toMatchObject({ system: 1_000, estimatedTotal: 5_000 })
  })
})

describe("scaleCategories", () => {
  it("按真实总量缩放，百分比加总接近 100", () => {
    const rows = scaleCategories(createStats(categories, 1), 12_000)
    expect(rows.reduce((sum, row) => sum + row.value, 0)).toBe(12_000)
    expect(rows.find((row) => row.key === "tool")?.value).toBe(4_800)
    expect(rows.reduce((sum, row) => sum + row.pct, 0)).toBeGreaterThanOrEqual(99)
  })

  it("估算为 0 时全部为 0", () => {
    const stats = createStats({ system: 0, tools: 0, tool: 0, text: 0, recent: 0, summaries: 0, media: 0 }, 1)
    expect(scaleCategories(stats, 10_000).every((row) => row.value === 0 && row.pct === 0)).toBe(true)
  })
})

describe("formatTokens", () => {
  it("按阈值切换单位", () => {
    expect(formatTokens(999)).toBe("999")
    expect(formatTokens(1_500)).toBe("1.5k")
    expect(formatTokens(15_000)).toBe("15k")
    expect(formatTokens(1_500_000)).toBe("1.5M")
  })

  it("非法输入不会显示 NaNM", () => {
    expect(formatTokens(Number.NaN)).toBe("0")
    expect(formatTokens(-1)).toBe("0")
  })
})
