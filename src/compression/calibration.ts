import type { ModelIdentity } from "../shared/settings.ts"
import { DEFAULT_TOKEN_COEFS, TOKEN_COEF_MAX, TOKEN_COEF_MIN, type CharCounts, type TokenCoefs } from "../shared/tokens.ts"
import { sessionChains, withSessionLock } from "./session-lock.ts"
import type { StorageLike } from "./state.ts"

/**
 * 按模型学习 token 估算系数。
 *
 * 输入：服务端 storage + 模型身份 + 单次真实 usage 观测。
 * 输出：该模型当前生效的 `{ cjk, ascii }` 系数 + 它来自哪一层。
 * 预期：分两层——`model:<modelID>` 是所有提供商共享的学习值，
 *       `<provider>/<modelID>` 是某家提供商自己的精确覆盖。
 *       读取顺序 精确 > 共享 > 默认；学习写回「当前生效的那一层」。
 */

/** 共享层键前缀；后面接归一化后的模型名。 */
export const MODEL_CALIBRATION_PREFIX = "calibration:model:"
/** 精确层键前缀；后面接 `providerID/modelID`。 */
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

/** 系数来自哪一层：精确覆盖、共享学习值，或内置默认。 */
export type CalibrationScope = "exact" | "model" | "default"

/** 生效系数 + 来源层。 */
export interface EffectiveCalibration {
  readonly state: CalibrationState
  readonly scope: CalibrationScope
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

/** 输入：模型名；输出：共享层用的归一化键（去首尾空白 + 小写）。 */
export function normalizeModelName(id: string): string {
  return id.trim().toLowerCase()
}

/** 输入：模型；输出：共享层 storage 键。 */
export function modelCalibrationKey(model: ModelIdentity): string {
  return `${MODEL_CALIBRATION_PREFIX}${normalizeModelName(model.id)}`
}

/** 输入：模型；输出：精确层 storage 键（按提供商区分）。 */
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

const cache = new Map<string, { readonly at: number; readonly value: EffectiveCalibration }>()

/** 输入：模型；输出：缓存里的生效值（可能过期）。 */
function cached(model: ModelIdentity): EffectiveCalibration | undefined {
  const hit = cache.get(calibrationKey(model))
  if (hit === undefined) return undefined
  if (Date.now() - hit.at > CACHE_TTL_MS) return undefined
  return hit.value
}

/** 输入：模型 + 生效值；输出：无；预期：同时刷新缓存。 */
function remember(model: ModelIdentity, value: EffectiveCalibration): void {
  cache.set(calibrationKey(model), { at: Date.now(), value })
}

/** 输入：storage + 键；输出：解析后的状态；读盘失败返回 undefined。 */
async function readLayer(storage: StorageLike, key: string): Promise<CalibrationState | undefined> {
  try {
    return parseCalibration(await storage.get(key))
  } catch {
    return undefined
  }
}

/**
 * 输入：storage + 模型。
 * 输出：生效状态 + 来源层。
 * 预期：精确覆盖优先；其次共享层；都没有就是默认值。读盘失败一律退回默认。
 */
export async function loadEffectiveCalibration(
  storage: StorageLike,
  model: ModelIdentity,
): Promise<EffectiveCalibration> {
  const hit = cached(model)
  if (hit !== undefined) return hit
  const exact = await readLayer(storage, calibrationKey(model))
  if (exact !== undefined) {
    const value: EffectiveCalibration = { state: exact, scope: "exact" }
    remember(model, value)
    return value
  }
  const shared = await readLayer(storage, modelCalibrationKey(model))
  const value: EffectiveCalibration =
    shared === undefined ? { state: DEFAULT_CALIBRATION, scope: "default" } : { state: shared, scope: "model" }
  remember(model, value)
  return value
}

/** 两层原始快照；精确层没有记录时不带该字段。 */
export interface CalibrationLayers {
  /** 共享层；没有记录时是默认状态。 */
  readonly model: CalibrationState
  readonly exact?: CalibrationState
}

/** 输入：storage + 模型；输出：共享层与精确层各自的原始值。预期：读盘失败按没有记录处理。 */
export async function loadCalibrationLayers(
  storage: StorageLike,
  model: ModelIdentity,
): Promise<CalibrationLayers> {
  const shared = await readLayer(storage, modelCalibrationKey(model))
  const exact = await readLayer(storage, calibrationKey(model))
  return {
    model: shared ?? DEFAULT_CALIBRATION,
    ...(exact === undefined ? {} : { exact }),
  }
}

/** 输入：storage + 模型；输出：生效状态（读不到就是默认状态）。 */
export async function loadCalibration(storage: StorageLike, model: ModelIdentity): Promise<CalibrationState> {
  return (await loadEffectiveCalibration(storage, model)).state
}

/** 输入：storage + 模型；输出：当前生效系数（读盘失败或没有记录时是默认值）。 */
export async function calibrationCoefs(storage: StorageLike, model: ModelIdentity): Promise<TokenCoefs> {
  return coefsOf(await loadCalibration(storage, model))
}

/** 输入：storage + 键 + 状态；输出：无；预期：写盘并让缓存失效，失败静默。 */
async function writeLayer(storage: StorageLike, key: string, state: CalibrationState): Promise<void> {
  try {
    await storage.set(key, state as unknown as Parameters<StorageLike["set"]>[1])
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
  const pPhi0 = state.p00 * cjkChars + state.p01 * asciiChars
  const pPhi1 = state.p01 * cjkChars + state.p11 * asciiChars
  const denom = FORGETTING + cjkChars * pPhi0 + asciiChars * pPhi1
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

/** 输入：模型；输出：串行锁键。 */
function lockKey(model: ModelIdentity): string {
  return `${model.providerID}/${model.id}`
}

/**
 * 输入：storage + 模型 + 观测。
 * 输出：无。
 * 预期：按模型串行读改写；写回「当前生效的那一层」——
 *       没设精确覆盖就写共享层（所有提供商一起受益），设了只更新那家。
 */
export async function recordCalibration(
  storage: StorageLike,
  model: ModelIdentity,
  sample: CalibrationSample,
): Promise<void> {
  await withSessionLock(chains, lockKey(model), async () => {
    const effective = await loadEffectiveCalibration(storage, model)
    const next = applyObservation(effective.state, sample)
    if (next === effective.state) return
    const key = effective.scope === "exact" ? calibrationKey(model) : modelCalibrationKey(model)
    await writeLayer(storage, key, next)
    cache.delete(calibrationKey(model))
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

/** 手动写入的目标层：共享层或某家提供商的精确层。 */
export type WritableScope = "exact" | "model"

/**
 * 输入：storage + 模型 + 用户手填的系数 + 目标层。
 * 输出：写入是否成功。
 * 预期：越界值拒绝写入；写精确层等于给这家提供商单独定系数，
 *       之后学习只更新这一层，共享层不受影响。
 */
export async function setManualCalibration(
  storage: StorageLike,
  model: ModelIdentity,
  coefs: TokenCoefs,
  scope: WritableScope,
): Promise<boolean> {
  if (!isCoefInRange(coefs)) return false
  await withSessionLock(chains, lockKey(model), async () => {
    const key = scope === "exact" ? calibrationKey(model) : modelCalibrationKey(model)
    const current = (await readLayer(storage, key)) ?? DEFAULT_CALIBRATION
    await writeLayer(storage, key, {
      ...current,
      cjk: coefs.cjk,
      ascii: coefs.ascii,
      updatedAt: Date.now(),
    })
    cache.delete(calibrationKey(model))
  })
  return true
}

/** 重置目标层：精确层、共享层，或两层都清。 */
export type ResetScope = WritableScope | "all"

/** 输入：storage + 模型 + 重置范围；输出：无；预期：删掉的层回落到下一层或默认值。 */
export async function resetCalibration(
  storage: StorageLike,
  model: ModelIdentity,
  scope: ResetScope,
): Promise<void> {
  const keys =
    scope === "all"
      ? [calibrationKey(model), modelCalibrationKey(model)]
      : [scope === "exact" ? calibrationKey(model) : modelCalibrationKey(model)]
  cache.delete(calibrationKey(model))
  await withSessionLock(chains, lockKey(model), async () => {
    for (const key of keys) {
      try {
        await storage.remove(key)
      } catch {
        // best effort
      }
    }
  })
}
