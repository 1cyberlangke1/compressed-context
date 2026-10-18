import { Plugin } from "@opencode/plugin"

import { createStats, mergeMetadata, shouldPublish, type ContextStats } from "./stats.ts"
import { estimateCategories } from "./tokens.ts"

export default Plugin.define({
  id: "compressed-context",

  /**
   * 输入：OpenCode 注入的插件上下文 ctx。
   * 输出：注册 session 的 "context" 钩子，并返回注销函数。
   * 预期：每次模型请求前估算上下文分类，节流写入 session metadata，
   *       供 TUI 插件读取；不修改 system / messages / tools。
   */
  async setup(ctx) {
    const published = new Map<string, ContextStats>()

    /**
     * 输入：sessionID + 本次统计。
     * 输出：无；metadata 合并已有键后整体写回。
     * 预期：失败静默，绝不阻塞模型请求。
     */
    const publish = async (sessionID: string, stats: ContextStats): Promise<void> => {
      const session = await ctx.session.get({ sessionID })
      await ctx.session.update({
        sessionID,
        metadata: mergeMetadata(session.metadata, stats),
      })
    }

    const registration = await ctx.session.hook("context", (input) => {
      const stats = createStats(
        estimateCategories({
          system: input.system,
          tools: input.tools,
          messages: input.messages,
        }),
        Date.now(),
      )
      if (!shouldPublish(published.get(input.sessionID), stats)) return
      published.set(input.sessionID, stats)
      void publish(input.sessionID, stats).catch(() => undefined)
    })

    return () => registration.dispose()
  },
})
