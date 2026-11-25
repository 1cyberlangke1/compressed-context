import type { ModelIdentity } from "../shared/settings.ts"
import { DEFAULT_TOKEN_COEFS, TOKEN_COEF_MAX, TOKEN_COEF_MIN, type CharCounts, type TokenCoefs } from "../shared/tokens.ts"
import { sessionChains, withSessionLock } from "./session-lock.ts"
import type { StorageLike } from "./state.ts"

/**
 * 按模型学习 token 估算系数。
 *
 * 输入：服务端 storage + 模型身份 + 单次真实 usage 观测。
 * 输出：该模型当前生效的 `{ cjk, ascii }` 系数。
 * 预期：用二维递推最小二乘（RLS）+ 遗忘因子 + 往默认值收缩，
 *       默认值等于旧规则（CJK 1 / ASCII 0.25），所以没有样本时行为与历史版本一致。
 */

/** 系数存储键前缀；后面接 `providerID/modelID`。 */
export const CALIBRATION_PREFIX = "calibration:"

/** 学习状态：两个系数 + 2×2 协方差 + 样本数。 */
export interface CalibrationState {
  readonly cjk: number
  readonly ascii: number
  readonly p00: number
  readonly p01: number
  readonly p11: number
  readonly samples: number
  readonly updatedAt: number
}

/** 无样本时的初始状态：系数等于默认值，协方差给足初始步长。 */
export const DEFAULT_CALIBRATION: CalibrationState = {
  cjk: DEFAULT_TOKEN_COEFS.cjk,
  ascii: DEFAULT_TOKEN_COEFS.ascii,
  p00: 4e-9,
  p01: 0,
  p11: 4e-10,
  samples: 0,
  updatedAt: 0,
}

/** 系数下限与上限；超出范围的观测不会把系数推出去。 */
export const COEF_MIN: TokenCoefs = TOKEN_COEF_MIN
export const COEF_MAX: TokenCoefs = TOKEN_COEF_MAX

/** 遗忘因子：越接近 1 越信任历史。 */
const FORGETTING = 0.99
/** 每步往默认值收缩的比例，防止组成单一时系数漂到无意义位置。 */
const RIDGE = 0.0005
/** 小于这个字符数的请求不参与采样：比例噪声太大。 */
const MIN_SAMPLE_CHARS = 20_000
/** 单次观测偏离预测超过这个比例就丢弃（缓存全命中、provider 异常等）。 */
const MAX_OBSERVATION_SKEW = 0.5
/** 缓存有效期；跨实例写盘后最多这么久能读到。 */
const CACHE_TTL_MS = 5_000

/** 输入：模型；输出：storage 键。 */
export function calibrationKey(model: ModelIdentity): string {
  return `${CALIBRATION_PREFIX}${model.providerID}/${model.id}`
}

/** 输入：任意值；输出：合法数字或 undefined。 */
function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** 输入：storage 里的原始值；输出：合法状态；缺字段或越界返回 undefined。 */
export function parseCalibration(value: unknown): CalibrationState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const cjk = readNumber(record["cjk"])
  const ascii = readNumber(record["ascii"])
  const p00 = readNumber(record["p00"])
  const p01 = readNumber(record["p01"])
  const p11 = readNumber(record["p11"])
  const samples = readNumber(record["samples"])
  const updatedAt = readNumber(record["updatedAt"])
  if (
    cjk === undefined ||
    ascii === undefined ||
    p00 === undefined ||
    p01 === undefined ||
    p11 === undefined ||
    samples === undefined ||
    updatedAt === undefined
  ) {
    return undefined
  }
  return { cjk, ascii, p00, p01, p11, samples, updatedAt }
}

/** 输入：系数；输出：夹到合法区间后的系数。 */
export function clampCoefs(coefs: TokenCoefs): TokenCoefs {
  return {
    cjk: Math.min(COEF_MAX.cjk, Math.max(COEF_MIN.cjk, coefs.cjk)),
    ascii: Math.min(COEF_MAX.ascii, Math.max(COEF_MIN.ascii, coefs.ascii)),
  }
}

/** 输入：状态；输出：可直接用于估算的系数。 */
export function coefsOf(state: CalibrationState): TokenCoefs {
  return { cjk: state.cjk, ascii: state.ascii }
}

const cache = new Map<string, { readonly at: number; readonly state: CalibrationState }>()

/** 输入：模型；输出：缓存里的状态（可能过期）。 */
function cached(model: ModelIdentity): CalibrationState | undefined {
  const hit = cache.get(calibrationKey(model))
  if (hit === undefined) return undefined
  if (Date.now() - hit.at > CACHE_TTL_MS) return undefined
  return hit.state
}

/** 输入：模型 + 状态；输出：无；预期：同时刷新缓存。 */
function remember(model: ModelIdentity, state: CalibrationState): void {
  cache.set(calibrationKey(model), { at: Date.now(), state })
}

/**
 * 输入：storage + 模型。
 * 输出：该模型的学习状态；没有记录时返回默认状态。
 * 预期：读盘失败不抛错——系数只是估算，退回默认值即可。
 */
export async function loadCalibration(storage: StorageLike, model: ModelIdentity): Promise<CalibrationState> {
  const hit = cached(model)
  if (hit !== undefined) return hit
  try {
    const state = parseCalibration(await storage.get(calibrationKey(model))) ?? DEFAULT_CALIBRATION
    remember(model, state)
    return state
  } catch {
    return DEFAULT_CALIBRATION
  }
}

/** 输入：storage + 模型；输出：当前生效系数（读盘失败或没有记录时是默认值）。 */
export async function calibrationCoefs(storage: StorageLike, model: ModelIdentity): Promise<TokenCoefs> {
  return coefsOf(await loadCalibration(storage, model))
}

/** 输入：storage + 模型 + 状态；输出：无；预期：写盘并刷新缓存，失败静默。 */
export async function saveCalibration(
  storage: StorageLike,
  model: ModelIdentity,
  state: CalibrationState,
): Promise<void> {
  remember(model, state)
  try {
    await storage.set(calibrationKey(model), state as unknown as Parameters<StorageLike["set"]>[1])
  } catch {
    // best effort：写不进去只影响下次启动后的系数
  }
}

/** 单次观测：提示词的字符构成 + provider 报告的真实 prompt token。 */
export interface CalibrationSample {
  readonly chars: CharCounts
  /** 真实 prompt token（input + cache.read + cache.write）。 */
  readonly realTokens: number
  /** 媒体那部分已经按表格估算过的 token；不参与回归。 */
  readonly mediaTokens: number
}

/** 输入：状态 + 观测；输出：更新后的状态；观测不可信时原样返回。 */
export function applyObservation(state: CalibrationState, sample: CalibrationSample): CalibrationState {
  const cjkChars = sample.chars.cjk
  const asciiChars = sample.chars.ascii
  const totalChars = cjkChars + asciiChars
  if (totalChars < MIN_SAMPLE_CHARS) return state
  if (!Number.isFinite(sample.realTokens) || sample.realTokens <= 0) return state

  // 目标值减掉媒体估算：媒体走固定表格，不参与系数拟合。
  const target = sample.realTokens - Math.max(0, sample.mediaTokens)
  if (target <= 0) return state

  const pred = state.cjk * cjkChars + state.ascii * asciiChars
  if (pred <= 0) return state
  if (Math.abs(target / pred - 1) > MAX_OBSERVATION_SKEW) return state

  // RLS：P 是 2×2 协方差，φ 是字符数向量。
  const phi0 = cjkChars
  const phi1 = asciiChars
  const pPhi0 = state.p00 * phi0 + state.p01 * phi1
  const pPhi1 = state.p01 * phi0 + state.p11 * phi1
  const denom = FORGETTING + phi0 * pPhi0 + phi1 * pPhi1
  if (denom <= 0) return state
  const k0 = pPhi0 / denom
  const k1 = pPhi1 / denom

  const error = target - pred
  let nextCjk = state.cjk + k0 * error
  let nextAscii = state.ascii + k1 * error

  // 协方差更新后再除以遗忘因子，保持持续适应能力。
  const nextP00 = (state.p00 - k0 * pPhi0) / FORGETTING
  const nextP01 = (state.p01 - k0 * pPhi1) / FORGETTING
  const nextP11 = (state.p11 - k1 * pPhi1) / FORGETTING

  // 往默认值收缩：组成单一时（只有中文或只有英文）也能保持合理分配。
  nextCjk += RIDGE * (DEFAULT_TOKEN_COEFS.cjk - nextCjk)
  nextAscii += RIDGE * (DEFAULT_TOKEN_COEFS.ascii - nextAscii)

  const clamped = clampCoefs({ cjk: nextCjk, ascii: nextAscii })

  return {
    cjk: clamped.cjk,
    ascii: clamped.ascii,
    p00: nextP00,
    p01: nextP01,
    p11: nextP11,
    samples: state.samples + 1,
    updatedAt: Date.now(),
  }
}

const chains = sessionChains(Symbol.for("compressed-context.calibration-chains"))

/**
 * 输入：storage + 模型 + 观测。
 * 输出：无。
 * 预期：按模型串行读改写，避免同模型的并发请求互相覆盖。
 */
export async function recordCalibration(
  storage: StorageLike,
  model: ModelIdentity,
  sample: CalibrationSample,
): Promise<void> {
  await withSessionLock(chains, `${model.providerID}/${model.id}`, async () => {
    const current = await loadCalibration(storage, model)
    const next = applyObservation(current, sample)
    if (next === current) return
    await saveCalibration(storage, model, next)
  })
}

/** 输入：系数；输出：是否落在合法区间（含边界）。 */
export function isCoefInRange(coefs: TokenCoefs): boolean {
  return (
    Number.isFinite(coefs.cjk) &&
    Number.isFinite(coefs.ascii) &&
    coefs.cjk >= COEF_MIN.cjk &&
    coefs.cjk <= COEF_MAX.cjk &&
    coefs.ascii >= COEF_MIN.ascii &&
    coefs.ascii <= COEF_MAX.ascii
  )
}

/**
 * 输入：storage + 模型 + 用户手填的系数。
 * 输出：写入是否成功。
 * 预期：只写系数并保留样本数与协方差形状；越界值拒绝写入，交给调用方报错。
 */
export async function setManualCalibration(
  storage: StorageLike,
  model: ModelIdentity,
  coefs: TokenCoefs,
): Promise<boolean> {
  if (!isCoefInRange(coefs)) return false
  await withSessionLock(chains, `${model.providerID}/${model.id}`, async () => {
    const current = await loadCalibration(storage, model)
    await saveCalibration(storage, model, {
      ...current,
      cjk: coefs.cjk,
      ascii: coefs.ascii,
      updatedAt: Date.now(),
    })
  })
  return true
}

/** 输入：storage + 模型；输出：无；预期：删除学习记录，回到默认系数重新学。 */
export async function resetCalibration(storage: StorageLike, model: ModelIdentity): Promise<void> {
  cache.delete(calibrationKey(model))
  await withSessionLock(chains, `${model.providerID}/${model.id}`, async () => {
    try {
      await storage.remove(calibrationKey(model))
    } catch {
      // best effort
    }
  })
}
