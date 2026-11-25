import { describe, expect, it } from "vitest"

import {
  applyObservation,
  calibrationCoefs,
  calibrationKey,
  clampCoefs,
  COEF_MAX,
  COEF_MIN,
  DEFAULT_CALIBRATION,
  isCoefInRange,
  loadCalibration,
  loadCalibrationLayers,
  loadEffectiveCalibration,
  modelCalibrationKey,
  normalizeModelName,
  parseCalibration,
  recordCalibration,
  resetCalibration,
  setManualCalibration,
} from "../src/compression/calibration.ts"
import { DEFAULT_TOKEN_COEFS } from "../src/shared/tokens.ts"
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

const SAMPLE = { chars: { cjk: 0, ascii: 80_000 }, realTokens: 30_000, mediaTokens: 0 }

describe("calibration 默认值", () => {
  it("没有记录时等于旧规则（CJK 1 / ASCII 0.25）", async () => {
    const effective = await loadEffectiveCalibration(memoryStorage(), freshModel())
    expect(effective.scope).toBe("default")
    expect(effective.state).toEqual(DEFAULT_CALIBRATION)
  })

  it("坏记录回落到默认状态", async () => {
    const storage = memoryStorage()
    const model = freshModel()
    await storage.set(modelCalibrationKey(model), { cjk: "x" })
    expect(await loadCalibration(storage, model)).toEqual(DEFAULT_CALIBRATION)
  })

  it("parseCalibration 接受合法状态、拒绝缺字段", () => {
    expect(parseCalibration({ ...DEFAULT_CALIBRATION })).toEqual(DEFAULT_CALIBRATION)
    expect(parseCalibration({ cjk: 1, ascii: 0.25 })).toBeUndefined()
    expect(parseCalibration(null)).toBeUndefined()
  })

  it("共享层键做 trim + 小写归一化", () => {
    expect(normalizeModelName("  DeepSeek-V4.1  ")).toBe("deepseek-v4.1")
    expect(modelCalibrationKey({ providerID: "p", id: " ABC " })).toBe("calibration:model:abc")
    expect(calibrationKey({ providerID: "p", id: "ABC" })).toBe("calibration:p/ABC")
  })
})

describe("calibration 学习", () => {
  it("ASCII 被低估时 ascii 系数上升，一次观测走完大部分差距", () => {
    const next = applyObservation(DEFAULT_CALIBRATION, SAMPLE)
    // 目标：30000/80000 = 0.375；一次观测后应明显靠近但不超过目标。
    expect(next.ascii).toBeGreaterThan(0.25)
    expect(next.ascii).toBeLessThan(0.375)
    expect(next.samples).toBe(1)
  })

  it("重复观测会收敛到真实比例", () => {
    let state = DEFAULT_CALIBRATION
    for (let index = 0; index < 200; index += 1) state = applyObservation(state, SAMPLE)
    // 往默认值收缩会留下一点稳态偏差，收敛到 0.375 附近即可。
    expect(Math.abs(state.ascii - 0.375)).toBeLessThan(0.01)
  })

  it("CJK 被高估时 cjk 系数下降", () => {
    const next = applyObservation(DEFAULT_CALIBRATION, {
      chars: { cjk: 40_000, ascii: 0 },
      realTokens: 24_000,
      mediaTokens: 0,
    })
    expect(next.cjk).toBeLessThan(1)
    expect(next.cjk).toBeGreaterThan(0.4)
  })

  it("字符数太少不采样", () => {
    const next = applyObservation(DEFAULT_CALIBRATION, {
      chars: { cjk: 100, ascii: 200 },
      realTokens: 500,
      mediaTokens: 0,
    })
    expect(next).toBe(DEFAULT_CALIBRATION)
  })

  it("真实 token 非正或缺失时跳过", () => {
    const chars = { cjk: 0, ascii: 80_000 }
    expect(applyObservation(DEFAULT_CALIBRATION, { chars, realTokens: 0, mediaTokens: 0 })).toBe(
      DEFAULT_CALIBRATION,
    )
    expect(applyObservation(DEFAULT_CALIBRATION, { chars, realTokens: Number.NaN, mediaTokens: 0 })).toBe(
      DEFAULT_CALIBRATION,
    )
  })

  it("偏离预测超过 50% 的观测直接丢弃", () => {
    const next = applyObservation(DEFAULT_CALIBRATION, {
      chars: { cjk: 0, ascii: 80_000 },
      realTokens: 80_000,
      mediaTokens: 0,
    })
    expect(next).toBe(DEFAULT_CALIBRATION)
  })

  it("媒体 token 从目标值里扣掉", () => {
    const withoutMedia = applyObservation(DEFAULT_CALIBRATION, SAMPLE)
    const withMedia = applyObservation(DEFAULT_CALIBRATION, { ...SAMPLE, realTokens: 35_000, mediaTokens: 5_000 })
    expect(withMedia.ascii).toBeCloseTo(withoutMedia.ascii, 6)
  })
})

describe("calibration 两层键", () => {
  it("没设精确层时，学习写共享层，其他提供商同样受益", async () => {
    const storage = memoryStorage()
    const [a, b] = providerPair()
    await recordCalibration(storage, a, SAMPLE)
    expect((await loadEffectiveCalibration(storage, a)).scope).toBe("model")
    const coefsA = await calibrationCoefs(storage, a)
    const coefsB = await calibrationCoefs(storage, b)
    expect(coefsA).toEqual(coefsB)
    expect(coefsA.ascii).toBeGreaterThan(0.25)
  })

  it("精确层覆盖共享层，且只影响那一家", async () => {
    const storage = memoryStorage()
    const [a, b] = providerPair()
    await recordCalibration(storage, a, SAMPLE)
    expect(await setManualCalibration(storage, a, { cjk: 1.1, ascii: 0.5 }, "exact")).toBe(true)

    const effectiveA = await loadEffectiveCalibration(storage, a)
    expect(effectiveA.scope).toBe("exact")
    expect(effectiveA.state.ascii).toBe(0.5)

    const effectiveB = await loadEffectiveCalibration(storage, b)
    expect(effectiveB.scope).toBe("model")
    expect(effectiveB.state.ascii).toBeLessThan(0.5)
  })

  it("有精确层时学习只写精确层，共享层不动", async () => {
    const storage = memoryStorage()
    const [a, b] = providerPair()
    await recordCalibration(storage, a, SAMPLE)
    const sharedBefore = (await loadCalibrationLayers(storage, a)).model
    await setManualCalibration(storage, a, { cjk: 1, ascii: 0.6 }, "exact")

    await recordCalibration(storage, a, SAMPLE)
    const sharedAfter = (await loadCalibrationLayers(storage, a)).model
    const exactAfter = (await loadCalibrationLayers(storage, a)).exact

    expect(sharedAfter).toEqual(sharedBefore)
    expect(exactAfter?.ascii).toBeLessThan(0.6)
    expect(exactAfter?.ascii).toBeGreaterThan(0.25)
    // 另一家仍用共享层
    expect((await calibrationCoefs(storage, b)).ascii).toBeCloseTo(sharedAfter.ascii, 6)
  })

  it("删掉精确层后回落到共享层", async () => {
    const storage = memoryStorage()
    const [a] = providerPair()
    await recordCalibration(storage, a, SAMPLE)
    const shared = await calibrationCoefs(storage, a)
    await setManualCalibration(storage, a, { cjk: 1.5, ascii: 0.8 }, "exact")
    await resetCalibration(storage, a, "exact")
    expect(await loadEffectiveCalibration(storage, a)).toMatchObject({ scope: "model" })
    expect(await calibrationCoefs(storage, a)).toEqual(shared)
  })

  it("清共享层后两家都回到默认值", async () => {
    const storage = memoryStorage()
    const [a, b] = providerPair()
    await recordCalibration(storage, a, SAMPLE)
    await resetCalibration(storage, a, "model")
    expect(await calibrationCoefs(storage, a)).toEqual(DEFAULT_TOKEN_COEFS)
    expect(await calibrationCoefs(storage, b)).toEqual(DEFAULT_TOKEN_COEFS)
  })

  it("越界的手动系数被拒绝、不写入", async () => {
    const storage = memoryStorage()
    const model = freshModel()
    expect(await setManualCalibration(storage, model, { cjk: 9, ascii: 0.25 }, "model")).toBe(false)
    expect(await setManualCalibration(storage, model, { cjk: 1, ascii: 0 }, "model")).toBe(false)
    expect(await calibrationCoefs(storage, model)).toEqual(DEFAULT_TOKEN_COEFS)
  })
})

describe("calibration 边界", () => {
  it("clampCoefs 把系数夹在区间内", () => {
    expect(clampCoefs({ cjk: 0, ascii: 0 })).toEqual(COEF_MIN)
    expect(clampCoefs({ cjk: 99, ascii: 99 })).toEqual(COEF_MAX)
    expect(clampCoefs({ cjk: 1, ascii: 0.25 })).toEqual({ cjk: 1, ascii: 0.25 })
  })

  it("isCoefInRange 只接受区间内的有限数", () => {
    expect(isCoefInRange({ cjk: 1, ascii: 0.25 })).toBe(true)
    expect(isCoefInRange({ cjk: Number.NaN, ascii: 0.25 })).toBe(false)
    expect(isCoefInRange({ cjk: COEF_MIN.cjk, ascii: COEF_MIN.ascii })).toBe(true)
    expect(isCoefInRange({ cjk: COEF_MAX.cjk, ascii: COEF_MAX.ascii })).toBe(true)
  })
})
