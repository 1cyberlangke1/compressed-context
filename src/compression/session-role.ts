import type { Plugin } from "@opencode/plugin"

/**
 * 输入：插件上下文 + 会话 ID。
 * 输出：该会话是否是子代理会话。
 * 预期：子代理会话有 parentID；查询失败按“是子代理”处理（fail-closed），
 *       宁可暂时少给一个工具，也不能把压缩工具暴露给短命的子会话。
 */
export async function isSubagentSession(ctx: Plugin.Context, sessionID: string): Promise<boolean> {
  const session = await ctx.session.get({ sessionID }).catch(() => undefined)
  if (session === undefined) return true
  const parentID = session.parentID
  return typeof parentID === "string" && parentID.length > 0
}

/**
 * 输入：请求的工具表 + 要隐藏的工具名。
 * 输出：无；预期：直接删除键，模型下一次请求就看不到这些工具。
 */
export function hideTools(
  tools: Record<string, unknown>,
  names: readonly string[],
): void {
  for (const name of names) Reflect.deleteProperty(tools, name)
}
