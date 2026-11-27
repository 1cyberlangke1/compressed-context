import { describe, expect, it } from "vitest"

import {
  applyObservation,
  arrayToCoefs,
  calibrationCoefs,
  calibrationKey,
  coefsToArray,
  DEFAULT_CALIBRATION,
  effectiveCoefsOf,
  isCoefArrayInRange,
  loadCalibration,
  loadEffectiveCalibration,
  modelCalibrationKey,
  normalizeModelName,
  parseCalibration,
  recordCalibration,
  resetCalibration,
  setManualCalibration,
} from "../src/compression/calibration.ts"
import { BUCKET_NAMES, DEFAULT_BUCKET_COEFS, emptyBuckets, priceBuckets } from "../src/shared/tokens.ts"
import type { StorageLike } from "../src/compression/state.ts"

/** 内存 storage：键值对，行为与插件 ctx.storage 一致。 */
function memoryStorage(): StorageLike {
  const values = new Map<string, unknown>()
  return {
    get: (key) => Promise.resolve(values.get(key) as never),
    set: (key, value) => {
      values.set(key, value)
      return Promise.resolve()
    },
    remove: (key) => {
      values.delete(key)
      return Promise.resolve()
    },
  }
}

/** 每个用例用独立模型 id：校准表有进程级缓存，共用 id 会串味。 */
let seq = 0
function freshModel(): { providerID: string; id: string } {
  seq += 1
  return { providerID: "prov", id: `model-${seq.toString()}` }
}

/** 同一个模型名、两个不同的提供商：用来验证共享层。 */
function providerPair(): readonly [
  { providerID: string; id: string },
  { providerID: string; id: string },
] {
  seq += 1
  const id = `shared-${seq.toString()}`
  return [
    { providerID: "prov-a", id },
    { providerID: "prov-b", id },
  ]
}

/** 构造纯 ASCII 的桶计数（只碰 latin/ws/punct 这些）。 */
function asciiBuckets(units: number) {
  const buckets = { ...emptyBuckets(), latin: units }
  return buckets
}

describe("calibration 默认值", () => {
  it("没有记录时等于离线先验", async () => {
    const effective = await loadEffectiveCalibration(memoryStorage(), freshModel())
    expect(effective.scope).toBe("default")
    expect(effective.source).toBe("prior")
    expect(effective.coefs).toEqual(DEFAULT_BUCKET_COEFS)
  })

  it("坏记录回落到先验状态", async () => {
    const storage = memoryStorage()
    const model = freshModel()
    await storage.set(modelCalibrationKey(model), { coefs: "x" })
    expect(await loadCalibration(storage, model)).toEqual(DEFAULT_CALIBRATION)
  })

  it("parseCalibration 接受合法状态、拒绝缺字段", () => {
    expect(parseCalibration({ ...DEFAULT_CALIBRATION })).toEqual(DEFAULT_CALIBRATION)
    expect(parseCalibration({ coefs: [1] })).toBeUndefined()
    expect(parseCalibration(null)).toBeUndefined()
  })

  it("键名归一化：共享层 trim + 小写，精确层保留原样", () => {
    expect(normalizeModelName("  DeepSeek-V4.1  ")).toBe("deepseek-v4.1")
    expect(modelCalibrationKey({ providerID: "p", id: " ABC " })).toBe("calibration:model:abc")
    expect(calibrationKey({ providerID: "p", id: "ABC" })).toBe("calibration:p/ABC")
  })

  it("系数数组与桶名对象可互转", () => {
    const arrays = coefsToArray(DEFAULT_BUCKET_COEFS)
    expect(arrays).toHaveLength(BUCKET_NAMES.length)
    expect(arrayToCoefs(arrays)).toEqual(DEFAULT_BUCKET_COEFS)
    // 长度不对时退回先验，避免把坏数据当系数用。
    expect(arrayToCoefs([1, 2, 3])).toEqual(DEFAULT_BUCKET_COEFS)
  })
})

describe("calibration 学习", () => {
  it("先验低估时学习值上升，并在足够样本后取代先验", () => {
    const buckets = asciiBuckets(80_000)
    const priorPred = priceBuckets(buckets, DEFAULT_BUCKET_COEFS)
    const target = Math.round(priorPred * 1.4)
    let state = DEFAULT_CALIBRATION
    for (let index = 0; index < 40; index += 1) {
      state = applyObservation(state, { buckets, realTokens: target, mediaTokens: 0 })
    }
    const learned = arrayToCoefs(state.coefs)
    expect(learned.latin).toBeGreaterThan(DEFAULT_BUCKET_COEFS.latin)
    const effective = effectiveCoefsOf(state)
    expect(effective.source).toBe("learned")
    expect(priceBuckets(buckets, effective.coefs)).toBeGreaterThan(priorPred)
  })

  it("样本不足时仍然使用先验", () => {
    const buckets = asciiBuckets(80_000)
    const target = Math.round(priceBuckets(buckets, DEFAULT_BUCKET_COEFS) * 1.4)
    let state = DEFAULT_CALIBRATION
    for (let index = 0; index < 3; index += 1) {
      state = applyObservation(state, { buckets, realTokens: target, mediaTokens: 0 })
    }
    expect(effectiveCoefsOf(state).source).toBe("prior")
  })

  it("纯 ASCII 观测不会推动 CJK 系数", () => {
    const buckets = asciiBuckets(80_000)
    const target = Math.round(priceBuckets(buckets, DEFAULT_BUCKET_COEFS) * 1.3)
    let state = DEFAULT_CALIBRATION
    for (let index = 0; index < 50; index += 1) {
      state = applyObservation(state, { buckets, realTokens: target, mediaTokens: 0 })
    }
    const index = BUCKET_NAMES.indexOf("cjk")
    expect(state.coefs[index]).toBeCloseTo(DEFAULT_BUCKET_COEFS.cjk, 6)
  })

  it("没出现过的桶连收缩都不做", () => {
    const buckets = asciiBuckets(80_000)
    const target = Math.round(priceBuckets(buckets, DEFAULT_BUCKET_COEFS) * 1.3)
    let state = applyObservation(DEFAULT_CALIBRATION, { buckets, realTokens: target, mediaTokens: 0 })
    // 先手动把某个未出现的桶推离先验，再观测：它必须原地不动。
    const cjkIndex = BUCKET_NAMES.indexOf("cjk")
    state = { ...state, coefs: state.coefs.map((value, i) => (i === cjkIndex ? 1.5 : value)) }
    const next = applyObservation(state, { buckets, realTokens: target, mediaTokens: 0 })
    expect(next.coefs[cjkIndex]).toBe(1.5)
  })

  it("桶总数太少不采样", () => {
    const buckets = { ...emptyBuckets(), latin: 100 }
    expect(applyObservation(DEFAULT_CALIBRATION, { buckets, realTokens: 500, mediaTokens: 0 })).toBe(
      DEFAULT_CALIBRATION,
    )
  })

  it("真实 token 非正或缺失时跳过", () => {
    const buckets = asciiBuckets(80_000)
    expect(applyObservation(DEFAULT_CALIBRATION, { buckets, realTokens: 0, mediaTokens: 0 })).toBe(
      DEFAULT_CALIBRATION,
    )
    expect(applyObservation(DEFAULT_CALIBRATION, { buckets, realTokens: Number.NaN, mediaTokens: 0 })).toBe(
      DEFAULT_CALIBRATION,
    )
  })

  it("偏差超过 50% 的观测直接丢弃（对称基准：低估到 1/3）", () => {
    const buckets = asciiBuckets(80_000)
    const target = Math.round(priceBuckets(buckets, DEFAULT_BUCKET_COEFS) * 3)
    expect(applyObservation(DEFAULT_CALIBRATION, { buckets, realTokens: target, mediaTokens: 0 })).toBe(
      DEFAULT_CALIBRATION,
    )
  })

  it("低估一半的观测不再被丢弃（对称基准）", () => {
    // 真实值是先验估算的 2 倍：相对真实误差 50%，旧的相对预测判断是 100% 会被丢。
    const buckets = asciiBuckets(80_000)
    const pred = priceBuckets(buckets, DEFAULT_BUCKET_COEFS)
    const target = Math.round(pred * 2)
    const next = applyObservation(DEFAULT_CALIBRATION, { buckets, realTokens: target, mediaTokens: 0 })
    expect(next.samples).toBe(1)
  })

  it("低估与高估同样幅度时对称处理", () => {
    const buckets = asciiBuckets(80_000)
    const pred = priceBuckets(buckets, DEFAULT_BUCKET_COEFS)
    // 真实值 = 预测一半：相对预测误差 50%，旧判断正好卡在边界不丢；对称基准也应不丢。
    const target = Math.round(pred / 2)
    const next = applyObservation(DEFAULT_CALIBRATION, { buckets, realTokens: target, mediaTokens: 0 })
    expect(next.samples).toBe(1)
  })

  it("偏差带符号：低估为负、高估为正", () => {
    const buckets = asciiBuckets(80_000)
    const pred = priceBuckets(buckets, DEFAULT_BUCKET_COEFS)
    // 真实值高于预测 → 估算偏低 → bias 为负
    const low = applyObservation(DEFAULT_CALIBRATION, {
      buckets,
      realTokens: Math.round(pred * 1.3),
      mediaTokens: 0,
    })
    expect(low.biasPrior).toBeLessThan(0)
    // 真实值低于预测 → 估算偏高 → bias 为正
    const high = applyObservation(DEFAULT_CALIBRATION, {
      buckets,
      realTokens: Math.round(pred / 1.3),
      mediaTokens: 0,
    })
    expect(high.biasPrior).toBeGreaterThan(0)
  })

  it("旧状态缺少偏差字段时按 0 处理", () => {
    const legacy = { ...DEFAULT_CALIBRATION, samples: 5, emaPrior: 0.1, emaLearned: 0.05 } as Record<string, unknown>
    delete legacy["biasPrior"]
    delete legacy["biasLearned"]
    const parsed = parseCalibration(legacy)
    expect(parsed?.biasPrior).toBe(0)
    expect(parsed?.biasLearned).toBe(0)
  })

  it("媒体 token 从目标值里扣掉", () => {
    const buckets = asciiBuckets(80_000)
    const target = Math.round(priceBuckets(buckets, DEFAULT_BUCKET_COEFS) * 1.3)
    const plain = applyObservation(DEFAULT_CALIBRATION, { buckets, realTokens: target, mediaTokens: 0 })
    const withMedia = applyObservation(DEFAULT_CALIBRATION, {
      buckets,
      realTokens: target + 5_000,
      mediaTokens: 5_000,
    })
    expect(withMedia.coefs).toEqual(plain.coefs)
  })
})

describe("calibration 两层键", () => {
  it("没设精确层时写共享层，其他提供商同样受益", async () => {
    const storage = memoryStorage()
    const [a, b] = providerPair()
    const buckets = asciiBuckets(80_000)
    const target = Math.round(priceBuckets(buckets, DEFAULT_BUCKET_COEFS) * 1.4)
    await recordCalibration(storage, a, { buckets, realTokens: target, mediaTokens: 0 })
    expect((await loadEffectiveCalibration(storage, a)).scope).toBe("model")
    expect(await calibrationCoefs(storage, a)).toEqual(await calibrationCoefs(storage, b))
  })

  it("精确层覆盖共享层，且只影响那一家", async () => {
    const storage = memoryStorage()
    const [a, b] = providerPair()
    const shared = coefsToArray(DEFAULT_BUCKET_COEFS)
    const manual = shared.map((value) => value * 1.2)
    expect(await setManualCalibration(storage, a, manual, "exact")).toBe(true)

    const effectiveA = await loadEffectiveCalibration(storage, a)
    expect(effectiveA.scope).toBe("exact")
    expect(coefsToArray(effectiveA.coefs)).toEqual(manual)

    const effectiveB = await loadEffectiveCalibration(storage, b)
    expect(effectiveB.scope).toBe("default")
  })

  it("删掉精确层后回落到共享层", async () => {
    const storage = memoryStorage()
    const [a] = providerPair()
    const buckets = asciiBuckets(80_000)
    const target = Math.round(priceBuckets(buckets, DEFAULT_BUCKET_COEFS) * 1.3)
    await recordCalibration(storage, a, { buckets, realTokens: target, mediaTokens: 0 })
    const shared = await calibrationCoefs(storage, a)
    await setManualCalibration(storage, a, coefsToArray(DEFAULT_BUCKET_COEFS).map((v) => v * 1.5), "exact")
    await resetCalibration(storage, a, "exact")
    expect((await loadEffectiveCalibration(storage, a)).scope).toBe("model")
    expect(await calibrationCoefs(storage, a)).toEqual(shared)
  })

  it("清共享层后回到先验", async () => {
    const storage = memoryStorage()
    const [a, b] = providerPair()
    const buckets = asciiBuckets(80_000)
    const target = Math.round(priceBuckets(buckets, DEFAULT_BUCKET_COEFS) * 1.3)
    await recordCalibration(storage, a, { buckets, realTokens: target, mediaTokens: 0 })
    await resetCalibration(storage, a, "model")
    expect(await calibrationCoefs(storage, a)).toEqual(DEFAULT_BUCKET_COEFS)
    expect(await calibrationCoefs(storage, b)).toEqual(DEFAULT_BUCKET_COEFS)
  })

  it("越界的手动系数被拒绝、不写入", async () => {
    const storage = memoryStorage()
    const model = freshModel()
    const tooBig = coefsToArray(DEFAULT_BUCKET_COEFS).map((value) => value * 99)
    expect(await setManualCalibration(storage, model, tooBig, "model")).toBe(false)
    expect(await setManualCalibration(storage, model, [1, 2], "model")).toBe(false)
    expect(await calibrationCoefs(storage, model)).toEqual(DEFAULT_BUCKET_COEFS)
  })

  it("isCoefArrayInRange 只接受每个桶都在区间内的数组", () => {
    expect(isCoefArrayInRange(coefsToArray(DEFAULT_BUCKET_COEFS))).toBe(true)
    expect(isCoefArrayInRange([Number.NaN])).toBe(false)
    expect(isCoefArrayInRange(coefsToArray(DEFAULT_BUCKET_COEFS).map(() => -1))).toBe(false)
  })
})

