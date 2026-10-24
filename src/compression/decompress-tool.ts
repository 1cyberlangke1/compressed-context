import type { Plugin } from "@opencode/plugin"
import { Schema } from "effect"

import { effectiveDecompressInlineMax, effectiveDecompressTempCap } from "../shared/settings.ts"
import { loadServerSettings } from "./settings.ts"
import { isSubagentSession } from "./session-role.ts"
import type { Disposable } from "./settings-rpc.ts"

const DESCRIPTION =
  "Restores content from a compressed checkpoint block. Use when you need exact details that were " +
  "compressed away (exact errors, code lines, file contents, tool outputs). Pass the block id you see " +
  "in the checkpoint (e.g. b3). By default a merged block expands one level (its child summaries); " +
  "pass full:true to recurse all the way to the original messages. Large content is written to a " +
  "temporary file whose path is returned — open it with the read tool. This tool never changes the " +
  "checkpoint; content returns only as this tool's result."

const DecompressInput = Schema.Struct({
  block: Schema.String,
  full: Schema.Boolean,
})

const DecompressOutput = Schema.Struct({
  inline: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  tokens: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
})

/**
 * 输入：错误文案。
 * 输出：工具失败返回体。
 * 预期：`output.error`、`content` 前缀、`metadata.error` 三处形状固定；
 *       不含 `status` 字段——decompress 的输出契约与 compress 不同。
 */
function failure(message: string) {
  return {
    output: { error: message },
    content: `ERROR: ${message}`,
    metadata: { error: true },
  }
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
          return failure("decompress is unavailable in subagent sessions")
        }
        const { resolveDecompress } = await import("./decompress.ts")
        const settings = await loadServerSettings(ctx)
        if (!settings.enableDecompressTool) {
          return failure("decompress tool is disabled in settings")
        }
        const result = await resolveDecompress(input, ctx, toolCtx.sessionID, {
          inlineMax: effectiveDecompressInlineMax(settings),
          tempCap: effectiveDecompressTempCap(settings),
          showTokens: settings.decompressShowTokens,
        })
        if (result.status === "error") {
          return failure(result.message)
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
