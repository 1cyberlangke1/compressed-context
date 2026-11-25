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

describe("calibration 默认值", () => {
  it("没有记录时等于旧规则（CJK 1 / ASCII 0.25）", async () => {
    const coefs = await calibrationCoefs(memoryStorage(), freshModel())
    expect(coefs).toEqual(DEFAULT_TOKEN_COEFS)
  })

  it("坏记录回落到默认状态", async () => {
    const storage = memoryStorage()
    const model = freshModel()
    await storage.set(calibrationKey(model), { cjk: "x" })
    expect(await loadCalibration(storage, model)).toEqual(DEFAULT_CALIBRATION)
  })

  it("parseCalibration 接受合法状态、拒绝缺字段", () => {
    expect(parseCalibration({ ...DEFAULT_CALIBRATION })).toEqual(DEFAULT_CALIBRATION)
    expect(parseCalibration({ cjk: 1, ascii: 0.25 })).toBeUndefined()
    expect(parseCalibration(null)).toBeUndefined()
  })
})

describe("calibration 学习", () => {
  it("ASCII 被低估时 ascii 系数上升，一次观测走完大部分差距", () => {
    const next = applyObservation(DEFAULT_CALIBRATION, {
      chars: { cjk: 0, ascii: 80_000 },
      realTokens: 30_000,
      mediaTokens: 0,
    })
    // 目标：30000/80000 = 0.375；一次观测后应明显靠近但不超过目标。
    expect(next.ascii).toBeGreaterThan(0.25)
    expect(next.ascii).toBeLessThan(0.375)
    expect(next.samples).toBe(1)
  })

  it("重复观测会收敛到真实比例", () => {
    let state = DEFAULT_CALIBRATION
    const chars = { cjk: 0, ascii: 80_000 }
    // 后端真实按每 ASCII 字符 0.375 token 计费；观测值固定，不随我们的预测变化。
    for (let index = 0; index < 200; index += 1) {
      state = applyObservation(state, { chars, realTokens: 30_000, mediaTokens: 0 })
    }
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
    const withoutMedia = applyObservation(DEFAULT_CALIBRATION, {
      chars: { cjk: 0, ascii: 80_000 },
      realTokens: 30_000,
      mediaTokens: 0,
    })
    const withMedia = applyObservation(DEFAULT_CALIBRATION, {
      chars: { cjk: 0, ascii: 80_000 },
      realTokens: 35_000,
      mediaTokens: 5_000,
    })
    expect(withMedia.ascii).toBeCloseTo(withoutMedia.ascii, 6)
  })
})

describe("calibration 落盘与手动覆盖", () => {
  it("recordCalibration 写盘后能读回，且不同模型互不影响", async () => {
    const storage = memoryStorage()
    const model = freshModel()
    await recordCalibration(storage, model, {
      chars: { cjk: 0, ascii: 80_000 },
      realTokens: 30_000,
      mediaTokens: 0,
    })
    expect((await loadCalibration(storage, model)).samples).toBe(1)
    expect(await calibrationCoefs(storage, freshModel())).toEqual(DEFAULT_TOKEN_COEFS)
  })

  it("手动系数写进去后继续被观测修正", async () => {
    const storage = memoryStorage()
    const model = freshModel()
    expect(await setManualCalibration(storage, model, { cjk: 1.2, ascii: 0.4 })).toBe(true)
    expect(await calibrationCoefs(storage, model)).toEqual({ cjk: 1.2, ascii: 0.4 })

    await recordCalibration(storage, model, {
      chars: { cjk: 0, ascii: 80_000 },
      realTokens: 30_000,
      mediaTokens: 0,
    })
    const after = await calibrationCoefs(storage, model)
    // 手填的 0.4 高于真实 0.375：观测会把它往下拉。
    expect(after.ascii).toBeLessThan(0.4)
    expect(after.ascii).toBeGreaterThan(0.25)
  })

  it("越界的手动系数被拒绝、不写入", async () => {
    const storage = memoryStorage()
    const model = freshModel()
    expect(await setManualCalibration(storage, model, { cjk: 9, ascii: 0.25 })).toBe(false)
    expect(await setManualCalibration(storage, model, { cjk: 1, ascii: 0 })).toBe(false)
    expect(await calibrationCoefs(storage, model)).toEqual(DEFAULT_TOKEN_COEFS)
  })

  it("重置后回到默认值", async () => {
    const storage = memoryStorage()
    const model = freshModel()
    await setManualCalibration(storage, model, { cjk: 1.2, ascii: 0.4 })
    await resetCalibration(storage, model)
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
