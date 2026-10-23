import { Rpc } from "@opencode/plugin/rpc"

import type { SummaryBlock } from "./blocks.ts"
import type { CacheSample } from "./cache.ts"
import type { CompressionSettings } from "./settings.ts"

const SettingsGetInputJson = {
  type: "object",
  properties: { sessionID: { type: "string" } },
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
} as const

const SettingsInputJson = {
  type: "object",
  properties: SettingsProperties,
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
  properties: { ok: { type: "boolean" } },
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

/** TUI 与服务端共用的设置 / 面板 RPC。 */
export const ContextRpc: Rpc.PortableDefinition = Rpc.define({
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
})

/** 服务端设置读取结果。 */
export interface ContextSettingsResult extends CompressionSettings {
  readonly resolvedWindow?: number
}

/** TUI 侧对 ContextRpc 的类型化视图。 */
export interface ContextRpcClient {
  settingsGet(input: { readonly sessionID?: string }): Promise<ContextSettingsResult>
  settingsSet(input: CompressionSettings): Promise<{ readonly ok: boolean }>
  blocksGet(input: { readonly sessionID: string }): Promise<{ readonly blocks: readonly SummaryBlock[] }>
  cacheHistoryGet(input: {
    readonly sessionID: string
  }): Promise<{ readonly samples: readonly CacheSample[] }>
  nativeCompactionDisable(input: {
    readonly path: string
  }): Promise<{ readonly ok: boolean; readonly error?: string }>
}

/** 输入：带 rpc 方法的 TUI client；输出：类型化 RPC 客户端。 */
export function contextRpc(client: {
  rpc(definition: Rpc.PortableDefinition): unknown
}): ContextRpcClient {
  return client.rpc(ContextRpc) as ContextRpcClient
}
