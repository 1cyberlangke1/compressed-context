import { Rpc } from "@opencode/plugin/rpc"

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
  summaryBlockPercent: { type: "number" },
  summaryTotalPercent: { type: "number" },
  summaryLanguage: { type: "string", enum: ["auto", "zh", "en"] },
  autoCompress: { type: "boolean" },
  enableCompressTool: { type: "boolean" },
  enableDecompressTool: { type: "boolean" },
  showTimeline: { type: "boolean" },
  showBlockTokens: { type: "boolean" },
  decompressInlineMax: { type: "number" },
  decompressTempCap: { type: "number" },
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
    title: { type: "string" },
    at: { type: "number" },
    tokensBefore: { type: "number" },
    tokensAfter: { type: "number" },
    sourceBlockIds: { type: "array", items: { type: "string" } },
    body: { type: "string" },
  },
  required: ["id", "tier", "title", "at", "tokensBefore", "tokensAfter", "body"],
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
  },
  events: {},
})
