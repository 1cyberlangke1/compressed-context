import type { ModelIdentity } from "../shared/settings.ts"
import {
  BUCKET_NAMES,
  DEFAULT_BUCKET_COEFS,
  priceBuckets,
  type BucketCoefs,
  type BucketCounts,
  type BucketName,
} from "../shared/tokens.ts"
import { sessionChains, withSessionLock } from "./session-lock.ts"
import type { StorageLike } from "./state.ts"

/**
 * 按模型学习 13 桶 token 估算系数。
 *
 * 输入：服务端 storage + 模型身份 + 单次真实 usage 观测。
 * 输出：该模型当前生效的系数 + 它来自先验还是学习。
 * 预期：默认值是离线拟合的先验；在线用带掩码与收缩的 RLS 修正，
 *       并维护「先验 vs 学习」两套误差，只有明确更优才切到学习值。
 */

/** 共享层键前缀；后面接归一化后的模型名。 */
export const MODEL_CALIBRATION_PREFIX = "calibration:model:"
/** 精确层键前缀；后面接 `providerID/modelID`。 */
export const CALIBRATION_PREFIX = "calibration:"

const DIM = BUCKET_NAMES.length

/** 学习状态：13 个系数 + 13×13 协方差 + 两套误差。 */
export interface CalibrationState {
  readonly coefs: readonly number[]
  /** 行主序的 13×13 协方差。 */
  readonly p: readonly number[]
  readonly samples: number
  readonly updatedAt: number
  /** 用先验预测时的指数移动平均相对误差。 */
  readonly emaPrior: number
  /** 用学习值预测时的指数移动平均相对误差。 */
  readonly emaLearned: number
  /** 是否是用户手填的系数；手填后立刻生效，第一次观测起交回影子判定。 */
  readonly manual?: boolean
}

/** 系数来自哪里：精确覆盖层、共享学习值，或内置先验。 */
export type CalibrationScope = "exact" | "model" | "default"

/** 生效系数 + 来源层 + 当前是否在用学习值。 */
export interface EffectiveCalibration {
  readonly state: CalibrationState
  readonly scope: CalibrationScope
  /** 实际用于估算的系数：学习未证明更优时就是先验。 */
  readonly coefs: BucketCoefs
  /** 当前生效的是「学习值」还是「先验」。 */
  readonly source: "learned" | "prior"
}

/** 输入：桶名 → 系数的对象；输出：按固定顺序的数组。 */
export function coefsToArray(coefs: BucketCoefs): number[] {
  return BUCKET_NAMES.map((name) => coefs[name])
}

/** 输入：数组；输出：桶名 → 系数的对象；长度不对时退回先验。 */
export function arrayToCoefs(values: readonly number[]): BucketCoefs {
  if (values.length !== DIM) return DEFAULT_BUCKET_COEFS
  const result = {} as Record<BucketName, number>
  for (let index = 0; index < DIM; index += 1) {
    const name = BUCKET_NAMES[index]
    if (name === undefined) continue
    const value = values[index] ?? 0
    result[name] = Number.isFinite(value) && value >= 0 ? value : 0
  }
  return result
}

/** 输入：无；输出：对角协方差。 */
function diagonal(scale: number): number[] {
  const p = new Array<number>(DIM * DIM).fill(0)
  for (let i = 0; i < DIM; i += 1) p[i * DIM + i] = scale
  return p
}

/** 无样本时的初始状态：系数等于先验。 */
export const DEFAULT_CALIBRATION: CalibrationState = {
  coefs: coefsToArray(DEFAULT_BUCKET_COEFS),
  p: diagonal(1e-9),
  samples: 0,
  updatedAt: 0,
  emaPrior: 0,
  emaLearned: 0,
}

/** 遗忘因子：越接近 1 越信任历史。 */
const FORGETTING = 0.99
/** 每步往先验收缩的比例，并按样本数从强到弱。 */
const RIDGE_STRONG = 0.02
const RIDGE_WEAK = 0.002
const RIDGE_RAMP_SAMPLES = 200
/** 小于这个总桶数的请求不参与采样：比例噪声太大。 */
const MIN_SAMPLE_UNITS = 20_000
/** 单次观测偏离预测超过这个比例就丢弃。 */
const MAX_OBSERVATION_SKEW = 0.5
/** 误差 EMA 的权重。 */
const EMA_ALPHA = 0.1
/** 需要这么多样本、并且学习误差比先验低才切换到学习值。 */
const SWITCH_MIN_SAMPLES = 8
const SWITCH_MARGIN = 0.95
/** 缓存有效期。 */
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

/** 输入：任意值；输出：长度正确的有限数数组或 undefined。 */
function readNumbers(value: unknown, length: number): number[] | undefined {
  if (!Array.isArray(value) || value.length !== length) return undefined
  const out: number[] = []
  for (const item of value) {
    const number = readNumber(item)
    if (number === undefined) return undefined
    out.push(number)
  }
  return out
}

/** 输入：storage 里的原始值；输出：合法状态；缺字段或越界返回 undefined。 */
export function parseCalibration(value: unknown): CalibrationState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const coefs = readNumbers(record["coefs"], DIM)
  const p = readNumbers(record["p"], DIM * DIM)
  const samples = readNumber(record["samples"])
  const updatedAt = readNumber(record["updatedAt"])
  const emaPrior = readNumber(record["emaPrior"])
  const emaLearned = readNumber(record["emaLearned"])
  if (
    coefs === undefined ||
    p === undefined ||
    samples === undefined ||
    updatedAt === undefined ||
    emaPrior === undefined ||
    emaLearned === undefined
  ) {
    return undefined
  }
  return { coefs, p, samples, updatedAt, emaPrior, emaLearned, ...(record["manual"] === true ? { manual: true } : {}) }
}

/** 输入：先验值；输出：该维的合法区间；预期：允许 grow 到两倍多、缩到一半以下。 */
function bandOf(prior: number): { readonly lo: number; readonly hi: number } {
  if (prior <= 0) return { lo: 0, hi: 0.6 }
  return { lo: Math.max(0, prior * 0.5 - 0.05), hi: prior * 2 + 0.1 }
}

/** 缓存：键是 `provider/model`。 */
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
 * 输入：状态。
 * 输出：实际应当用于估算的系数 + 来源。
 * 预期：样本不足或学习误差不优于先验时用先验，保证「学坏了退回先验」。
 */
export function effectiveCoefsOf(state: CalibrationState): {
  readonly coefs: BucketCoefs
  readonly source: "learned" | "prior"
} {
  const learned = arrayToCoefs(state.coefs)
  const usable =
    state.manual === true ||
    (state.samples >= SWITCH_MIN_SAMPLES &&
      state.emaLearned > 0 &&
      state.emaPrior > 0 &&
      state.emaLearned < state.emaPrior * SWITCH_MARGIN)
  return usable ? { coefs: learned, source: "learned" } : { coefs: DEFAULT_BUCKET_COEFS, source: "prior" }
}

/** 输入：状态 + 来源层；输出：生效值。 */
function toEffective(state: CalibrationState, scope: CalibrationScope): EffectiveCalibration {
  const { coefs, source } = effectiveCoefsOf(state)
  return { state, scope, coefs, source }
}

/**
 * 输入：storage + 模型。
 * 输出：生效值 + 来源层。
 * 预期：精确覆盖优先；其次共享层；都没有就是先验。
 */
export async function loadEffectiveCalibration(
  storage: StorageLike,
  model: ModelIdentity,
): Promise<EffectiveCalibration> {
  const hit = cached(model)
  if (hit !== undefined) return hit
  const exact = await readLayer(storage, calibrationKey(model))
  if (exact !== undefined) {
    const value = toEffective(exact, "exact")
    remember(model, value)
    return value
  }
  const shared = await readLayer(storage, modelCalibrationKey(model))
  const value = shared === undefined ? toEffective(DEFAULT_CALIBRATION, "default") : toEffective(shared, "model")
  remember(model, value)
  return value
}

/** 输入：storage + 模型；输出：生效状态（读不到就是先验状态）。 */
export async function loadCalibration(storage: StorageLike, model: ModelIdentity): Promise<CalibrationState> {
  return (await loadEffectiveCalibration(storage, model)).state
}

/** 输入：storage + 模型；输出：实际用于估算的系数。 */
export async function calibrationCoefs(storage: StorageLike, model: ModelIdentity): Promise<BucketCoefs> {
  return (await loadEffectiveCalibration(storage, model)).coefs
}

/** 两层原始快照；精确层没有记录时不带该字段。 */
export interface CalibrationLayers {
  readonly model: CalibrationState
  readonly exact?: CalibrationState
}

/** 输入：storage + 模型；输出：共享层与精确层各自的原始值。 */
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

/** 输入：storage + 键 + 状态；输出：无；预期：写盘并让缓存失效，失败静默。 */
async function writeLayer(storage: StorageLike, key: string, state: CalibrationState): Promise<void> {
  try {
    await storage.set(key, state as unknown as Parameters<StorageLike["set"]>[1])
  } catch {
    // best effort：写不进去只影响下次启动后的系数
  }
}

/** 单次观测：提示词的桶计数 + provider 报告的真实 prompt token。 */
export interface CalibrationSample {
  readonly buckets: BucketCounts
  /** 真实 prompt token（input + cache.read + cache.write）。 */
  readonly realTokens: number
  /** 媒体那部分已经按表格估算过的 token；不参与回归。 */
  readonly mediaTokens: number
}

/** 输入：状态；输出：13 维计数向量。 */
function vectorOf(buckets: BucketCounts): number[] {
  return BUCKET_NAMES.map((name) => buckets[name])
}

/**
 * 输入：状态 + 观测。
 * 输出：更新后的状态；观测不可信时原样返回。
 * 预期：只在「本次出现过的桶」上更新系数与收缩，纯 ASCII 请求不会推动 CJK 系数。
 */
export function applyObservation(state: CalibrationState, sample: CalibrationSample): CalibrationState {
  const phi = vectorOf(sample.buckets)
  const units = phi.reduce((sum, value) => sum + value, 0)
  if (units < MIN_SAMPLE_UNITS) return state
  if (!Number.isFinite(sample.realTokens) || sample.realTokens <= 0) return state

  const target = sample.realTokens - Math.max(0, sample.mediaTokens)
  if (target <= 0) return state

  const learned = arrayToCoefs(state.coefs)
  const predLearned = priceBuckets(sample.buckets, learned)
  const predPrior = priceBuckets(sample.buckets, DEFAULT_BUCKET_COEFS)
  if (predLearned <= 0 || predPrior <= 0) return state
  if (Math.abs(target / predLearned - 1) > MAX_OBSERVATION_SKEW) return state

  // 两套预测的误差都要记：学习值必须证明自己比先验更准才会被采用。
  const errorLearned = Math.abs(predLearned - target) / target
  const errorPrior = Math.abs(predPrior - target) / target
  const emaLearned =
    state.emaLearned === 0 ? errorLearned : state.emaLearned * (1 - EMA_ALPHA) + errorLearned * EMA_ALPHA
  const emaPrior = state.emaPrior === 0 ? errorPrior : state.emaPrior * (1 - EMA_ALPHA) + errorPrior * EMA_ALPHA

  // RLS：P 是 13×13 协方差，φ 是本次的桶计数向量。
  const p = state.p.slice()
  const pPhi = new Array<number>(DIM).fill(0)
  for (let row = 0; row < DIM; row += 1) {
    let sum = 0
    for (let col = 0; col < DIM; col += 1) sum += (p[row * DIM + col] ?? 0) * (phi[col] ?? 0)
    pPhi[row] = sum
  }
  let denom = FORGETTING
  for (let i = 0; i < DIM; i += 1) denom += (phi[i] ?? 0) * (pPhi[i] ?? 0)
  if (denom <= 0) return state

  const gain = new Array<number>(DIM).fill(0)
  for (let i = 0; i < DIM; i += 1) {
    // 掩码：本次没出现的桶不接收误差，避免被相关维度间接推动。
    gain[i] = (phi[i] ?? 0) > 0 ? (pPhi[i] ?? 0) / denom : 0
  }

  const residual = target - predLearned
  const coefs = state.coefs.slice()
  for (let i = 0; i < DIM; i += 1) coefs[i] = (coefs[i] ?? 0) + (gain[i] ?? 0) * residual

  // 协方差更新后再除以遗忘因子，保持持续适应能力。
  const nextP = new Array<number>(DIM * DIM).fill(0)
  for (let row = 0; row < DIM; row += 1) {
    for (let col = 0; col < DIM; col += 1) {
      let sum = 0
      for (let k = 0; k < DIM; k += 1) sum += (gain[k] ?? 0) * (p[k * DIM + col] ?? 0)
      nextP[row * DIM + col] = ((p[row * DIM + col] ?? 0) - (phi[row] ?? 0) * sum) / FORGETTING
    }
  }

  // 收缩只作用在本次出现过的桶上；按样本数从强到弱。
  const ridge = Math.max(RIDGE_WEAK, RIDGE_STRONG * (1 - state.samples / RIDGE_RAMP_SAMPLES))
  const prior = coefsToArray(DEFAULT_BUCKET_COEFS)
  for (let i = 0; i < DIM; i += 1) {
    if ((phi[i] ?? 0) <= 0) continue
    const value = coefs[i] ?? 0
    coefs[i] = value + ridge * ((prior[i] ?? 0) - value)
  }

  // 每维夹在「先验的一半到两倍」区间内。
  for (let i = 0; i < DIM; i += 1) {
    const band = bandOf(prior[i] ?? 0)
    coefs[i] = Math.min(band.hi, Math.max(band.lo, coefs[i] ?? 0))
  }

  return {
    coefs,
    p: nextP,
    samples: state.samples + 1,
    updatedAt: Date.now(),
    emaPrior,
    emaLearned,
    // 第一次观测起，手填值也要和先验比一比；影子判定接手。
    manual: false,
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
 * 预期：按模型串行读改写；写回「当前生效的那一层」。
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

/** 输入：系数数组；输出：是否每一项都落在对应区间（含边界）。 */
export function isCoefArrayInRange(values: readonly number[]): boolean {
  if (values.length !== DIM) return false
  for (let i = 0; i < DIM; i += 1) {
    const value = values[i] ?? Number.NaN
    const band = bandOf(coefsToArray(DEFAULT_BUCKET_COEFS)[i] ?? 0)
    if (!Number.isFinite(value) || value < band.lo || value > band.hi) return false
  }
  return true
}

/** 手动写入的目标层：共享层或某家提供商的精确层。 */
export type WritableScope = "exact" | "model"

/**
 * 输入：storage + 模型 + 用户手填的系数 + 目标层。
 * 输出：写入是否成功。
 * 预期：越界值拒绝写入；手填后清空误差记录，让学习重新证明自己。
 */
export async function setManualCalibration(
  storage: StorageLike,
  model: ModelIdentity,
  values: readonly number[],
  scope: WritableScope,
): Promise<boolean> {
  if (!isCoefArrayInRange(values)) return false
  await withSessionLock(chains, lockKey(model), async () => {
    const key = scope === "exact" ? calibrationKey(model) : modelCalibrationKey(model)
    const current = (await readLayer(storage, key)) ?? DEFAULT_CALIBRATION
    await writeLayer(storage, key, {
      ...current,
      coefs: [...values],
      updatedAt: Date.now(),
      emaPrior: 0,
      emaLearned: 0,
      // 手填后立刻生效；第一次观测起交给影子判定。
      manual: true,
    })
    cache.delete(calibrationKey(model))
  })
  return true
}

/** 重置目标层：精确层、共享层，或两层都清。 */
export type ResetScope = WritableScope | "all"

/** 输入：storage + 模型 + 重置范围；输出：无；预期：删掉的层回落到下一层或先验。 */
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
