import type { Rpc } from "@opencode/plugin/rpc"

import type { SummaryBlock } from "./blocks.ts"
import type { CacheSample } from "./cache.ts"
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

const SettingsProperties = {
  contextLimit: {
    anyOf: [{ type: "string", enum: ["auto"] }, { type: "number" }],
  },
  triggerPercent: { type: "number" },
  nudgeGrowthTokens: { type: "number" },
  summaryBlockPercent: { type: "number" },
  summaryTotalPercent: { type: "number" },
  summaryLanguage: { type: "string", enum: ["auto", "zh", "en"] },
  summaryFormat: { type: "string", enum: ["json", "markdown", "babel"] },
  autoCompress: { type: "boolean" },
  enableCompressTool: { type: "boolean" },
  enableDecompressTool: { type: "boolean" },
  showTimeline: { type: "boolean" },
  showBlockTokens: { type: "boolean" },
  decompressInlineMax: { type: "number" },
  decompressTempCap: { type: "number" },
  decompressTempMaxAgeHours: { type: "number" },
  decompressShowTokens: { type: "boolean" },
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
  required: ["contextLimit", "triggerPercent"],
  additionalProperties: false,
} as const

/** 读取结果比写入多一个 resolvedWindow：auto 时从模型原生窗口解析出来的值。 */
const SettingsOutputJson = {
  type: "object",
  properties: {
    ...SettingsProperties,
    resolvedWindow: { type: "number" },
  },
  required: ["contextLimit", "triggerPercent"],
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
    tier: { type: "number", enum: [1, 2, 3] },
    format: { type: "string", enum: ["json", "markdown", "babel"] },
    title: { type: "string" },
    at: { type: "number" },
    sourceTokens: { type: "number" },
    summaryTokens: { type: "number" },
    sourceBlockIds: { type: "array", items: { type: "string" } },
    body: { type: "string" },
  },
  required: ["id", "tier", "format", "title", "at", "sourceTokens", "summaryTokens", "body"],
  additionalProperties: false,
} as const

const BlocksOutputJson = {
  type: "object",
  properties: { blocks: { type: "array", items: BlockJson } },
  required: ["blocks"],
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

const CacheHistoryOutputJson = {
  type: "object",
  properties: { samples: { type: "array", items: CacheSampleJson } },
  required: ["samples"],
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
    cacheHistoryGet: { input: SessionInputJson, output: CacheHistoryOutputJson },
    nativeCompactionDisable: {
      input: NativeCompactionDisableInputJson,
      output: NativeCompactionDisableOutputJson,
    },
  },
  events: {},
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
  cacheHistoryGet(
    input: { readonly sessionID: string },
    options?: { readonly location?: { readonly directory: string } },
  ): Promise<{ readonly samples: readonly CacheSample[] }>
  nativeCompactionDisable(
    input: {
      readonly path: string
    },
    options?: { readonly location?: { readonly directory: string } },
  ): Promise<{ readonly ok: boolean; readonly error?: string }>
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
