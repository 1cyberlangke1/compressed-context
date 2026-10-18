import { Rpc } from "@opencode/plugin/rpc"

const EmptyJson = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const

const SettingsJson = {
  type: "object",
  properties: {
    contextLimit: {
      anyOf: [{ type: "string", enum: ["auto"] }, { type: "number" }],
    },
    triggerPercent: { type: "number" },
    summaryBudgetTokens: { type: "number" },
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
    settingsGet: { input: EmptyJson, output: SettingsJson },
    settingsSet: { input: SettingsJson, output: OkJson },
  },
  events: {},
})
