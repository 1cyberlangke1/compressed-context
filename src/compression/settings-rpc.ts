import type { Plugin } from "@opencode/plugin"

import type { SummaryBlock } from "../shared/blocks.ts"
import { ContextRpc } from "../shared/rpc.ts"
import { loadCacheHistory, recordCacheHistory } from "./cache-history.ts"
import { disableNativeCompaction } from "./native-compaction.ts"
import { activeBlocks, renderSummary } from "./render.ts"
import { isBabelSummary, isMarkdownSummary } from "./schema.ts"
import { loadState } from "./state.ts"
import { normalizeSettings } from "../shared/settings.ts"
import {
  loadSettings,
  parseServerSettings,
  readStoredWindow,
  saveSettings,
  type ServerSettings,
} from "./settings.ts"

/** 注册句柄的最小结构。 */
export interface Disposable {
  dispose(): Promise<void>
}

/** 输入：RPC 参数；输出：TUI 传来的配置文件层；非法或缺失返回 undefined。 */
function readLayers(input: unknown): readonly string[] | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const value = (input as { readonly layers?: unknown }).layers
  if (!Array.isArray(value)) return undefined
  const layers = value.filter((item): item is string => typeof item === "string" && item.length > 0)
  return layers.length === 0 ? undefined : layers
}

/** 设置 RPC 的可选回调。 */
export interface SettingsRpcOptions {
  /** 输入：刚保存的设置；输出：无；预期：让 compress 工具的描述与参数跟着摘要格式切换。 */
  readonly onSaved?: (settings: ServerSettings) => Promise<void>
}

/**
 * 输入：服务端插件上下文 + 可选保存回调。
 * 输出：注册 settingsGet / settingsSet / blocksGet / cacheHistoryGet / nativeCompactionDisable，并返回注销句柄。
 * 预期：TUI 推来的设置存进 ctx.storage；非法值返回 ok:false；读取时带上最近解析到的原生窗口；
 *       blocksGet 只返回 active 链，cacheHistoryGet 读取前先补写当前上下文；
 *       保存成功后调用 onSaved，让依赖设置的运行时（工具描述）立刻更新。
 */
export async function registerSettingsRpc(
  ctx: Plugin.Context,
  options?: SettingsRpcOptions,
): Promise<Disposable> {
  return ctx.rpc.register(ContextRpc, {
    settingsGet: async (input) => {
      const layers = readLayers(input)
      const settings = await loadSettings(ctx, layers)
      const requested = (input as { readonly sessionID?: unknown }).sessionID
      const sessionID = typeof requested === "string" && requested.length > 0 ? requested : undefined
      // 优先返回当前会话模型自己的窗口；拿不到再退回最近一次解析值。
      // 没有 sessionID 时只读全局值——这是设置面板在会话创建前的行为。
      const resolvedWindow = await readStoredWindow(ctx, sessionID)
      return {
        ...settings,
        ...(resolvedWindow === undefined ? {} : { resolvedWindow }),
      }
    },
    settingsSet: async (input) => {
      const layers = readLayers(input)
      const current = await loadSettings(ctx, layers)
      const merged = { ...current, ...(input as Record<string, unknown>) }
      const parsed = parseServerSettings(merged)
      if (parsed === undefined) return { ok: false }
      const next = normalizeSettings(merged)
      try {
        await saveSettings(ctx, next, layers)
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      if (options?.onSaved !== undefined) await options.onSaved(parsed)
      return { ok: true }
    },
    blocksGet: async (input) => {
      const sessionID = (input as { readonly sessionID: string }).sessionID
      const state = await loadState(ctx.storage, sessionID)
      // 只返回模型实际看到的 active 链；被合并掉的源块不展示。
      const blocks: SummaryBlock[] = activeBlocks(state.blocks, state.pending).map((block) => ({
        id: block.id,
        tier: block.tier,
        depth: block.depth,
        format: isBabelSummary(block.summary)
          ? "babel"
          : isMarkdownSummary(block.summary)
            ? "markdown"
            : "json",
        title: block.summary.title,
        at: block.at,
        sourceTokens: block.sourceTokens,
        summaryTokens: block.summaryTokens,
        ...(block.sourceBlockIds === undefined ? {} : { sourceBlockIds: [...block.sourceBlockIds] }),
        body: renderSummary(block.summary),
      }))
      return { blocks }
    },
    cacheHistoryGet: async (input) => {
      const sessionID = (input as { readonly sessionID: string }).sessionID
      const history = await loadCacheHistory(ctx.storage, sessionID)
      // 只在历史为空时补写一次；已有历史时只读，避免每次 TUI 刷新都拉全文。
      if (history.samples.length === 0) {
        await recordCacheHistory(ctx, sessionID)
        const bootstrapped = await loadCacheHistory(ctx.storage, sessionID)
        return { samples: bootstrapped.samples }
      }
      return { samples: history.samples }
    },
    nativeCompactionDisable: async (input) => {
      const path = (input as { readonly path: string }).path
      return disableNativeCompaction(path)
    },
  })
}
