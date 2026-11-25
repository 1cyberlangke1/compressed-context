import type { Plugin } from "@opencode/plugin"
import type { Schema } from "effect"

import {
  appendCacheSampleFromStep,
  appendCacheSamples,
  cacheHistoryEquals,
  cacheHistoryKey,
  parseCacheHistory,
  sampleFromTokens,
  MAX_CACHE_DROPS,
  type CacheHistory,
} from "../shared/cache.ts"
import { appendCacheDrop } from "../shared/cache-drops.ts"
import { dropTracker, planCacheDrop } from "./cache-drops.ts"
import { isSessionDeleted } from "./deleted-sessions.ts"
import { loadServerSettings } from "./settings.ts"
import type { StorageLike } from "./state.ts"

/** 输入：storage + sessionID；输出：该会话的历史；缺失或损坏时为空历史。 */
export async function loadCacheHistory(
  storage: StorageLike,
  sessionID: string,
  maxDrops: number = MAX_CACHE_DROPS,
): Promise<CacheHistory> {
  return parseCacheHistory(await storage.get(cacheHistoryKey(sessionID)), maxDrops)
}

/**
 * 输入：storage + sessionID + 历史。
 * 输出：无。
 * 预期：写入 v2（样本 + 突变记录）；会话已删除（墓碑命中）时直接跳过，
 *       避免删除后迟到的 step/usage 再写下缓存 key。
 */
export async function saveCacheHistory(
  storage: StorageLike,
  sessionID: string,
  history: CacheHistory,
): Promise<void> {
  if (isSessionDeleted(sessionID)) return
  await storage.set(cacheHistoryKey(sessionID), history as unknown as Schema.Json)
}

/**
 * 输入：插件上下文 + sessionID + 单 step 的 assistant usage。
 * 输出：无。
 * 预期：tool loop 的后续 step 不触发 context/usage.updated 的完整读取，
 *       用 `session.step.ended` 事件里的 tokens 直接落一条缓存样本。
 *       开启缓存突变记录时，同时把这一轮报文与上一轮按 messageID 对齐后比较；
 *       对不上（重试/失败/原生压缩）就记 unknown，绝不硬比。
 */
export async function recordCacheHistoryStep(
  ctx: Plugin.Context,
  sessionID: string,
  input: {
    readonly messageID: string
    readonly tokens: {
      readonly input: number
      readonly output: number
      readonly reasoning: number
      readonly cache: { readonly read: number; readonly write: number }
    }
  },
): Promise<void> {
  try {
    const settings = await loadServerSettings(ctx)
    const tracker = dropTracker()
    if (!settings.cacheDropsEnabled) tracker.forget(sessionID)
    const maxDrops = Math.min(MAX_CACHE_DROPS, settings.cacheDropsMaxRecords)
    const history = await loadCacheHistory(ctx.storage, sessionID, maxDrops)
    // 上一条样本必须在本轮样本追加前取，否则会拿自己跟自己比。
    const previousSample = history.samples.at(-1)
    const samples = appendCacheSampleFromStep(history.samples, input.messageID, input.tokens)
    const sample = sampleFromTokens(input.messageID, input.tokens, Date.now())
    const pair = settings.cacheDropsEnabled ? tracker.consume(sessionID, input.messageID) : undefined
    const drop =
      pair === undefined || previousSample === undefined
        ? undefined
        : planCacheDrop({
            previousSample,
            sample,
            pair,
            threshold: settings.cacheDropsThreshold,
          })
    const drops = drop === undefined ? history.drops : appendCacheDrop(history.drops, drop, maxDrops)
    const next: CacheHistory = { v: 2, samples, drops }
    if (!cacheHistoryEquals(history, next)) {
      await saveCacheHistory(ctx.storage, sessionID, next)
    }
  } catch {
    // best effort：历史缺失不影响主流程
  }
}

/**
 * 输入：插件上下文 + sessionID。
 * 输出：无；预期：把当前上下文里未记录过的 assistant usage 追加进该会话的历史。
 *       失败只影响历史，不影响压缩与主流程。
 */
export async function recordCacheHistory(ctx: Plugin.Context, sessionID: string): Promise<void> {
  try {
    const messages = await ctx.session.context({ sessionID })
    const history = await loadCacheHistory(ctx.storage, sessionID)
    const samples = appendCacheSamples(history.samples, messages)
    const next: CacheHistory = { v: 2, samples, drops: history.drops }
    if (!cacheHistoryEquals(history, next)) {
      await saveCacheHistory(ctx.storage, sessionID, next)
    }
  } catch {
    // best effort：历史缺失不影响主界面
  }
}
