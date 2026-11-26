import type { Rpc } from "@opencode/plugin/rpc"

import type { SummaryBlock } from "./blocks.ts"
import type { CacheSample } from "./cache.ts"
import type { CacheDrop } from "./cache-drops.ts"
import type { Settings } from "./settings.ts"

/** 配置层路径：全局在前，项目由远到近。 */
const LayersJson = {
  type: "array",
  items: { type: "string" },
} as const

const SettingsGetInputJson = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    layers: LayersJson,
  },
  additionalProperties: false,
} as const

/**
 * 按模型覆盖的单条结构。
 * 必须显式声明，否则 `{ type: "object" }` 会被 JSON Schema 转成空结构体，
 * 解码时把里面的字段全部剥掉，表现就是「怎么设都会回退」。
 */
const ModelOverrideJson = {
  type: "object",
  properties: {
    contextLimit: { anyOf: [{ type: "string", enum: ["auto"] }, { type: "number" }] },
    triggerPercent: { type: "number" },
    nudgeGrowthTokens: { type: "number" },
    summaryBlockPercent: { type: "number" },
    summaryTotalPercent: { type: "number" },
    recentT1Blocks: { type: "number" },
  },
  additionalProperties: false,
} as const

/** 键是 `provider/model` 或单独的模型名。 */
const ModelsJson = {
  type: "object",
  additionalProperties: ModelOverrideJson,
} as const

const SettingsProperties = {
  models: ModelsJson,
  contextLimit: {
    anyOf: [{ type: "string", enum: ["auto"] }, { type: "number" }],
  },
  triggerPercent: { type: "number" },
  nudgeGrowthTokens: { type: "number" },
  summaryBlockPercent: { type: "number" },
  summaryTotalPercent: { type: "number" },
  recentT1Blocks: { type: "number" },
  summaryLanguage: { type: "string", enum: ["auto", "zh", "en"] },
  summaryFormat: { type: "string", enum: ["json", "markdown", "babel"] },
  autoCompress: { type: "boolean" },
  enableCompressTool: { type: "boolean" },
  enableDecompressTool: { type: "boolean" },
  enableCheckpointTreeTool: { type: "boolean" },
  showTimeline: { type: "boolean" },
  showBlockTokens: { type: "boolean" },
  decompressInlineMax: { type: "number" },
  decompressTempCap: { type: "number" },
  decompressTempMaxAgeHours: { type: "number" },
  decompressShowTokens: { type: "boolean" },
  cacheDropsEnabled: { type: "boolean" },
  cacheDropsThreshold: { type: "number" },
  cacheDropsMaxRecords: { type: "number" },
  cacheDropsExpanded: { type: "boolean" },
  showCacheDrops: { type: "boolean" },
  enabled: { type: "boolean" },
  expanded: { type: "boolean" },
  locale: { type: "string", enum: ["auto", "zh", "en"] },
  cacheExpanded: { type: "boolean" },
  showCacheChart: { type: "boolean" },
  cacheChartExpanded: { type: "boolean" },
  showCacheLog: { type: "boolean" },
  cacheLogExpanded: { type: "boolean" },
  showSummaries: { type: "boolean" },
  summariesExpanded: { type: "boolean" },
  nativeCompactionPromptDismissed: { type: "boolean" },
} as const

const SettingsInputJson = {
  type: "object",
  properties: {
    ...SettingsProperties,
    layers: LayersJson,
  },
  required: ["triggerPercent"],
  additionalProperties: false,
} as const

/** 读取结果比写入多一个 resolvedWindow：auto 时从模型原生窗口解析出来的值。 */
const SettingsOutputJson = {
  type: "object",
  properties: {
    ...SettingsProperties,
    resolvedWindow: { type: "number" },
  },
  required: ["triggerPercent"],
  additionalProperties: false,
} as const

const OkJson = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    error: { type: "string" },
  },
  required: ["ok"],
  additionalProperties: false,
} as const

/** 原生压缩写配置：TUI 只传路径，jsonc-parser 留在服务端。 */
const NativeCompactionDisableInputJson = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
  additionalProperties: false,
} as const

const NativeCompactionDisableOutputJson = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    error: { type: "string" },
  },
  required: ["ok"],
  additionalProperties: false,
} as const

/** 校准系数查询/写入：`model` 是 `providerID/modelID`。 */
/** 校准系数查询入参：`model` 是 `providerID/modelID`。 */
const CalibrationInputJson = {
  type: "object",
  properties: { model: { type: "string" } },
  required: ["model"],
  additionalProperties: false,
} as const

/** 校准系数的单层快照。 */
const CalibrationLayerJson = {
  type: "object",
  properties: {
    coefs: { type: "array", items: { type: "number" } },
    samples: { type: "number" },
    emaPrior: { type: "number" },
    emaLearned: { type: "number" },
  },
  required: ["coefs", "samples", "emaPrior", "emaLearned"],
  additionalProperties: false,
} as const

/** 校准查询：返回生效系数、来源层、两套误差与两层原始值。 */
const CalibrationOutputJson = {
  type: "object",
  properties: {
    scope: { type: "string", enum: ["exact", "model", "default"] },
    source: { type: "string", enum: ["learned", "prior"] },
    coefs: { type: "array", items: { type: "number" } },
    samples: { type: "number" },
    emaPrior: { type: "number" },
    emaLearned: { type: "number" },
    model: CalibrationLayerJson,
    exact: CalibrationLayerJson,
  },
  required: ["scope", "source", "coefs", "samples", "emaPrior", "emaLearned", "model"],
  additionalProperties: false,
} as const

const CalibrationSetInputJson = {
  type: "object",
  properties: {
    model: { type: "string" },
    coefs: { type: "array", items: { type: "number" } },
    scope: { type: "string", enum: ["exact", "model"] },
  },
  required: ["model", "coefs", "scope"],
  additionalProperties: false,
} as const

const CalibrationResetInputJson = {
  type: "object",
  properties: {
    model: { type: "string" },
    scope: { type: "string", enum: ["exact", "model", "all"] },
  },
  required: ["model", "scope"],
  additionalProperties: false,
} as const

/** 需要明确指定会话的只读查询。 */
const SessionInputJson = {
  type: "object",
  properties: { sessionID: { type: "string" } },
  required: ["sessionID"],
  additionalProperties: false,
} as const

/** 摘要块：服务端返回 active 链，body 是渲染好的 markdown。 */
const BlockJson = {
  type: "object",
  properties: {
    id: { type: "string" },
    tier: { type: "number", minimum: 1 },
    height: { type: "number", minimum: 1 },
    format: { type: "string", enum: ["json", "markdown", "babel"] },
    title: { type: "string" },
    at: { type: "number" },
    sourceTokens: { type: "number" },
    summaryTokens: { type: "number" },
    sourceBlockIds: { type: "array", items: { type: "string" } },
    sourceRange: {
      type: "object",
      properties: { first: { type: "string" }, last: { type: "string" } },
      required: ["first", "last"],
      additionalProperties: false,
    },
    body: { type: "string" },
  },
  required: ["id", "tier", "height", "format", "title", "at", "sourceTokens", "summaryTokens", "body"],
  additionalProperties: false,
} as const

const BlocksOutputJson = {
  type: "object",
  properties: { blocks: { type: "array", items: BlockJson } },
  required: ["blocks"],
  additionalProperties: false,
} as const

/**
 * 编辑一个摘要块。
 * expectedAt 是乐观并发令牌：TUI 打开编辑器时看到的 `block.at`，服务端比对不上就拒绝，
 * 避免把已经被合并掉的旧块写回去。
 */
const BlockUpdateInputJson = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    blockID: { type: "string" },
    expectedAt: { type: "number" },
    text: { type: "string" },
  },
  required: ["sessionID", "blockID", "expectedAt", "text"],
  additionalProperties: false,
} as const

/** 编辑失败原因码；界面文案在语言文件里按码取。 */
export type EditBlockErrorCode =
  | "compacting"
  | "nul"
  | "notFound"
  | "merged"
  | "stale"
  | "legacyJson"
  | "badHeader"
  | "tooLong"
  | "notSmaller"
  | "chainBudget"
  | "noSession"
  | "foreignSession"

/** 编辑回执：失败时 code 必填，a / b 是文案里要插的数字。 */
export interface BlockUpdateResult {
  readonly ok: boolean
  readonly code?: EditBlockErrorCode
  readonly a?: string
  readonly b?: string
}

/** 编辑回执：ok 为假时用 code + 数字参数回传原因，文案由 TUI 按语言渲染。 */
const BlockUpdateOutputJson = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    code: { type: "string" },
    a: { type: "string" },
    b: { type: "string" },
  },
  required: ["ok"],
  additionalProperties: false,
} as const

/** 一条缓存命中样本。 */
const CacheSampleJson = {
  type: "object",
  properties: {
    messageID: { type: "string" },
    at: { type: "number" },
    input: { type: "number" },
    output: { type: "number" },
    cached: { type: "number" },
    hitRate: { type: "number" },
  },
  required: ["messageID", "at", "input", "output", "cached", "hitRate"],
  additionalProperties: false,
} as const

/** 结构树节点 schema：最多 4 层逐层展开，避免递归 $ref 在宿主解码器里不受支持。 */
function dropNodeJson(depth: number): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      key: { type: "string" },
      chars: { type: "number" },
      text: { type: "string" },
      truncated: { type: "boolean" },
      ...(depth > 0 ? { children: { type: "array", items: dropNodeJson(depth - 1) } } : {}),
    },
    required: ["key", "chars"],
    additionalProperties: false,
  }
}

const CacheDropTreeJson = { type: "array", items: dropNodeJson(3) } as const

/** 一条缓存突变记录。 */
const CacheDropJson = {
  type: "object",
  properties: {
    messageID: { type: "string" },
    at: { type: "number" },
    kind: { type: "string", enum: ["primary", "compaction", "title", "generate", "unknown"] },
    model: { type: "string" },
    prevMessageID: { type: "string" },
    prompt: { type: "number" },
    hit: { type: "number" },
    hitRate: { type: "number" },
    prevPrompt: { type: "number" },
    prevHit: { type: "number" },
    prevHitRate: { type: "number" },
    dropPp: { type: "number" },
    tree: CacheDropTreeJson,
    cause: {
      type: "string",
      enum: ["system", "tools", "params", "history", "window", "append", "none", "unknown"],
    },
    breakPoint: {
      type: "object",
      properties: {
        segment: { type: "string" },
        offset: { type: "number" },
        before: { type: "string" },
        after: { type: "string" },
      },
      required: ["segment", "offset", "before", "after"],
      additionalProperties: false,
    },
    outline: {
      type: "array",
      items: {
        type: "object",
        properties: { key: { type: "string" }, chars: { type: "number" } },
        required: ["key", "chars"],
        additionalProperties: false,
      },
    },
    request: {
      type: "object",
      properties: {
        segment: { type: "string" },
        text: { type: "string" },
        truncated: { type: "boolean" },
      },
      required: ["segment", "text", "truncated"],
      additionalProperties: false,
    },
    bodies: {
      type: "object",
      properties: {
        body: { type: "string" },
        previousBody: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  required: [
    "messageID",
    "at",
    "prevMessageID",
    "prompt",
    "hit",
    "hitRate",
    "prevPrompt",
    "prevHit",
    "prevHitRate",
    "dropPp",
    "cause",
  ],
  additionalProperties: false,
} as const

const CacheHistoryOutputJson = {
  type: "object",
  properties: {
    samples: { type: "array", items: CacheSampleJson },
    drops: { type: "array", items: CacheDropJson },
  },
  required: ["samples", "drops"],
  additionalProperties: false,
} as const

/**
 * TUI 与服务端共用的设置 / 面板 RPC。
 *
 * 用字面量而不是 `Rpc.define(...)`：`define` 只做「错误名不能以 rpc. 开头」的运行时校验
 * 并把入参原样返回。改成纯字面量后 TUI 产物不再需要运行时导入 `@opencode/plugin/rpc`
 * （该模块不在宿主的运行时模块表里，npm 安装后无法解析）。
 */
export const ContextRpc: Rpc.PortableDefinition = {
  id: "compressed-context",
  methods: {
    settingsGet: { input: SettingsGetInputJson, output: SettingsOutputJson },
    settingsSet: { input: SettingsInputJson, output: OkJson },
    blocksGet: { input: SessionInputJson, output: BlocksOutputJson },
    blockUpdate: { input: BlockUpdateInputJson, output: BlockUpdateOutputJson },
    cacheHistoryGet: { input: SessionInputJson, output: CacheHistoryOutputJson },
    nativeCompactionDisable: {
      input: NativeCompactionDisableInputJson,
      output: NativeCompactionDisableOutputJson,
    },
    calibrationGet: { input: CalibrationInputJson, output: CalibrationOutputJson },
    calibrationSet: { input: CalibrationSetInputJson, output: OkJson },
    calibrationReset: { input: CalibrationResetInputJson, output: OkJson },
  },
  events: {
    settingsUpdated: { schema: SettingsOutputJson },
  },
}

/** 单层校准快照。 */
export interface CalibrationLayer {
  readonly coefs: readonly number[]
  readonly samples: number
  readonly emaPrior: number
  readonly emaLearned: number
}

/** 校准查询结果：生效系数 + 来源层 + 两层原始值。 */
export interface CalibrationSnapshot {
  readonly scope: "exact" | "model" | "default"
  readonly source: "learned" | "prior"
  readonly coefs: readonly number[]
  readonly samples: number
  readonly emaPrior: number
  readonly emaLearned: number
  readonly model: CalibrationLayer
  readonly exact?: CalibrationLayer
}

/** 服务端设置读取结果。 */
export interface ContextSettingsResult extends Settings {
  readonly resolvedWindow?: number
}

/** TUI 侧对 ContextRpc 的类型化视图。 */
export interface ContextRpcClient {
  settingsGet(
    input: { readonly sessionID?: string; readonly layers?: readonly string[] },
    options?: { readonly location?: { readonly directory: string } },
  ): Promise<ContextSettingsResult>
  settingsSet(
    input: Settings & { readonly layers?: readonly string[] },
    options?: { readonly location?: { readonly directory: string } },
  ): Promise<{ readonly ok: boolean; readonly error?: string }>
  blocksGet(
    input: { readonly sessionID: string },
    options?: { readonly location?: { readonly directory: string } },
  ): Promise<{ readonly blocks: readonly SummaryBlock[] }>
  blockUpdate(
    input: {
      readonly sessionID: string
      readonly blockID: string
      readonly expectedAt: number
      readonly text: string
    },
    options?: { readonly location?: { readonly directory: string } },
  ): Promise<BlockUpdateResult>
  cacheHistoryGet(
    input: { readonly sessionID: string },
    options?: { readonly location?: { readonly directory: string } },
  ): Promise<{ readonly samples: readonly CacheSample[]; readonly drops: readonly CacheDrop[] }>
  nativeCompactionDisable(
    input: {
      readonly path: string
    },
    options?: { readonly location?: { readonly directory: string } },
  ): Promise<{ readonly ok: boolean; readonly error?: string }>
  calibrationGet(
    input: { readonly model: string },
    options?: { readonly location?: { readonly directory: string } },
  ): Promise<CalibrationSnapshot>
  calibrationSet(
    input: {
      readonly model: string
      readonly coefs: readonly number[]
      readonly scope: "exact" | "model"
    },
    options?: { readonly location?: { readonly directory: string } },
  ): Promise<{ readonly ok: boolean; readonly error?: string }>
  calibrationReset(
    input: { readonly model: string; readonly scope: "exact" | "model" | "all" },
    options?: { readonly location?: { readonly directory: string } },
  ): Promise<{ readonly ok: boolean; readonly error?: string }>
  readonly events: {
    on(
      name: "settingsUpdated",
      handler: (event: { readonly data: ContextSettingsResult }) => void,
    ): () => void
  }
}

/** 输入：带 rpc 方法的 TUI client；输出：类型化 RPC 客户端。 */
export function contextRpc(client: {
  rpc(definition: Rpc.PortableDefinition): unknown
}): ContextRpcClient {
  return client.rpc(ContextRpc) as ContextRpcClient
}

/** 输入：TUI 上下文；输出：RPC 路由选项。预期：带 location 让请求打到会话所属实例。 */
export function rpcLocation(context: {
  readonly location?: { readonly directory: string } | undefined
}): {
  readonly location?: { readonly directory: string }
} | undefined {
  return context.location === undefined ? undefined : { location: { directory: context.location.directory } }
}

