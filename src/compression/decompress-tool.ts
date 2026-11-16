import type { Plugin } from "@opencode/plugin"
import { Schema } from "effect"

import { diagnostic, diagnosticResult, type Diagnostic } from "../shared/diagnostic.ts"
import { effectiveDecompressInlineMax, effectiveDecompressTempCap } from "../shared/settings.ts"
import { loadServerSettings } from "./settings.ts"
import { isSubagentSession } from "./session-role.ts"
import type { Disposable } from "./settings-rpc.ts"

const DESCRIPTION =
  "Restores compressed checkpoint content. Pass the block id (e.g. b3). Depth: default expands one " +
  "level; depth:N recurses N levels; full:true goes all the way to original messages. Deeper means " +
  "more content and more tokens — start shallow, go deeper only if needed."

const DecompressInput = Schema.Struct({
  block: Schema.String,
  full: Schema.optional(Schema.Boolean),
  depth: Schema.optional(Schema.Number),
})

const DecompressOutput = Schema.Struct({
  inline: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  tokens: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  at: Schema.optional(Schema.String),
  expected: Schema.optional(Schema.String),
  got: Schema.optional(Schema.String),
  excerpt: Schema.optional(Schema.String),
  fix: Schema.optional(Schema.String),
})

/**
 * 输入：错误码、核心摘要（等于 output.error）、可选精确字段。
 * 输出：工具失败返回体。
 * 预期：编译器式诊断走 diagnosticResult 单点渲染；不含 `status` 字段——decompress 的输出契约与 compress 不同。
 */
function failure(
  code: string,
  summary: string,
  extra?: {
    readonly at?: string
    readonly expected?: string
    readonly got?: string
    readonly excerpt?: string
    readonly fix?: string
  },
) {
  return diagnosticResult(diagnostic({ tool: "decompress", code, summary, ...(extra ?? {}) }), {})
}

/** 输入：解析层产出的诊断；输出：decompress 失败返回体。 */
function fromDiagnostic(d: Diagnostic) {
  return diagnosticResult(d, {})
}

/**
 * 输入：服务端插件上下文。
 * 输出：注册 decompress 工具，返回注销句柄。
 * 预期：只读操作——不修改块状态；内容作为 tool result 返回。
 */
export async function registerDecompressTool(ctx: Plugin.Context): Promise<Disposable> {
  const registration = await ctx.tool.transform((tools) => {
    tools.add({
      name: "decompress",
      options: { codemode: false },
      description: DESCRIPTION,
      input: DecompressInput,
      output: DecompressOutput,
      execute: async (input, toolCtx) => {
        // 第二道防线：context 钩子已经对子代理隐藏工具，这里再挡一次直接调用。
        if (await isSubagentSession(ctx, toolCtx.sessionID)) {
          return failure("SUBAGENT_DENIED", "decompress is unavailable in subagent sessions", {
            expected: "a top-level session",
            got: "a subagent session (parentID set)",
            fix: "call decompress from the main session, not from a subagent",
          })
        }
        const { resolveDecompress } = await import("./decompress.ts")
        const settings = await loadServerSettings(ctx)
        if (!settings.enableDecompressTool) {
          return failure("TOOL_DISABLED", "decompress tool is disabled in settings", {
            expected: "enableDecompressTool=true",
            got: "enableDecompressTool=false",
            fix: "turn the decompress tool on in settings, then call again",
          })
        }
        const result = await resolveDecompress(input, ctx, toolCtx.sessionID, {
          inlineMax: effectiveDecompressInlineMax(settings),
          tempCap: effectiveDecompressTempCap(settings),
          showTokens: settings.decompressShowTokens,
        })
        if (result.status === "error") {
          return fromDiagnostic(result.diagnostic)
        }
        const output: { inline?: string; path?: string; tokens?: number } = {
          ...(result.path === undefined ? {} : { path: result.path }),
          ...(result.tokens === undefined ? {} : { tokens: result.tokens }),
        }
        return {
          output,
          content: result.inline,
        }
      },
    })
  })
  return registration
}
