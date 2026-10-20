import { Rpc } from "@opencode/plugin/rpc"

const EmptyJson = {
  type: "object",
  properties: {},
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

/** TUI 与服务端共用的设置 RPC。 */
export const ContextRpc: Rpc.PortableDefinition = Rpc.define({
  id: "compressed-context",
  methods: {
    settingsGet: { input: EmptyJson, output: SettingsOutputJson },
    settingsSet: { input: SettingsInputJson, output: OkJson },
  },
  events: {},
})
