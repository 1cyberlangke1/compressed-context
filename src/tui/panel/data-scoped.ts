import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"

import type { SummaryBlock } from "../../shared/blocks.ts"
import type { CacheSample } from "../../shared/cache.ts"
import { contextRpc, rpcLocation } from "../../shared/rpc.ts"
import type { Settings } from "../../shared/settings.ts"
import { parseStats, STATS_KEY, TERMINAL_KEY, type ContextStats } from "../../shared/stats.ts"

/** 面板分区各自需要的数据范围；独立 slot 时只拉自己那份。 */
export type PanelDataScope = "all" | "context" | "cache" | "summaries"

/** Panel 需要的服务端数据；全部是响应式 accessor。 */
export interface PanelData {
  readonly stats: Accessor<ContextStats | undefined>
  readonly terminal: Accessor<string | undefined>
  readonly cache: Accessor<readonly CacheSample[]>
  readonly blocks: Accessor<readonly SummaryBlock[]>
}

/**
 * 输入：TUI 上下文 + sessionID + 设置 accessor。
 * 输出：统计 / 终止原因 / 缓存历史 / 摘要块。
 * 预期：挂载时拉取，usage/compaction/idle 时刷新；设置开关变化时重新拉取。
 */
export function usePanelData(input: {
  readonly context: Context
  readonly sessionID: string
  readonly settings: Accessor<Settings>
  readonly scope?: PanelDataScope
}): PanelData {
  const scope = input.scope ?? "all"
  const needStats = scope === "all" || scope === "context"
  const needCache = scope === "all" || scope === "cache"
  const needBlocks = scope === "all" || scope === "summaries"
  const [stats, setStats] = createSignal<ContextStats>()
  const [terminal, setTerminal] = createSignal<string>()
  const [cache, setCache] = createSignal<readonly CacheSample[]>([])
  const [blocks, setBlocks] = createSignal<readonly SummaryBlock[]>([])
  const rpc = () => contextRpc(input.context.client)

  /** 输入：无；输出：无；预期：从服务端拉取该会话持久化的缓存历史。 */
  const refreshCache = async (): Promise<void> => {
    if (!needCache) return
    try {
      const got = await rpc().cacheHistoryGet({ sessionID: input.sessionID }, rpcLocation(input.context))
      setCache(got.samples)
    } catch {
      // server plugin not loaded；保留上一次数据
    }
  }

  /** 输入：无；输出：无；预期：从服务端拉取 active 摘要链。 */
  const refreshBlocks = async (): Promise<void> => {
    if (!needBlocks || !input.settings().showSummaries) return
    try {
      const got = await rpc().blocksGet({ sessionID: input.sessionID }, rpcLocation(input.context))
      setBlocks(got.blocks)
    } catch {
      // server plugin not loaded；保留上一次数据
    }
  }

  /** 输入：无；输出：无；预期：从服务端重新拉取 session metadata 里的统计。 */
  const refresh = async (): Promise<void> => {
    if (!needStats) return
    try {
      const info = await input.context.client.session.get({ sessionID: input.sessionID })
      setStats(parseStats(info.metadata?.[STATS_KEY]))
      const rawTerminal = info.metadata?.[TERMINAL_KEY]
      setTerminal(typeof rawTerminal === "string" ? rawTerminal : undefined)
    } catch {
      // 统计缺失不影响主界面，保持上一次的值
    }
  }

  // 显示开关变化时重新拉取；首次挂载也会跑一次。
  createEffect(() => {
    if (input.settings().showCacheChart || input.settings().showCacheLog) void refreshCache()
  })
  createEffect(() => {
    if (input.settings().showSummaries) void refreshBlocks()
  })

  createEffect(() => {
    void refresh()
  })

  onCleanup(
    input.context.data.on("session.usage.updated", (event) => {
      if (event.data.sessionID !== input.sessionID) return
      void refresh()
      // 缓存历史由服务端在 usage.updated 时补写；这里同步刷新面板。
      if (input.settings().showCacheChart || input.settings().showCacheLog) void refreshCache()
    }),
  )
  onCleanup(
    input.context.data.on("session.compaction.ended", (event) => {
      if (event.data.sessionID !== input.sessionID) return
      void refresh()
      void refreshCache()
      void refreshBlocks()
    }),
  )
  onCleanup(
    input.context.data.on("session.idle", (event) => {
      if (event.data.sessionID !== input.sessionID) return
      void refresh()
      void refreshCache()
      void refreshBlocks()
    }),
  )

  return { stats, terminal, cache, blocks }
}
