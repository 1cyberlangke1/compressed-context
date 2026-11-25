import type { Plugin } from "@opencode/plugin"
import type { Schema } from "effect"

import {
  appendCacheSamples,
  cacheHistoryEquals,
  cacheHistoryKey,
  MAX_CACHE_DROPS,
  parseCacheHistory,
  sampleFromTokens,
  type CacheHistory,
  type StepTokens,
} from "../shared/cache.ts"
import { appendCacheDrop, type CacheRequestKind } from "../shared/cache-drops.ts"
import { dropTracker, planCacheDrop } from "./cache-drops.ts"
import { isSessionDeleted } from "./deleted-sessions.ts"
import { sessionChains, withSessionLock } from "./session-lock.ts"
import { loadServerSettings } from "./settings.ts"
import type { StorageLike } from "./state.ts"

/** 缓存历史读改写串行链；与压缩状态锁分开。 */
const cacheChains = sessionChains(Symbol.for("compressed-context.cache-history"))

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

/** 一次请求的 usage 与身份；primary 用 assistant messageID，其它请求用 `kind:时间`。 */
export interface CacheUsageInput {
  readonly sampleID: string
  readonly kind: CacheRequestKind
  readonly tokens: StepTokens
  readonly model?: string
}

/**
 * 输入：插件上下文 + sessionID + 一次请求的 usage。
 * 输出：无。
 * 预期：同一会话的缓存历史读改写串行；primary / compaction / generate / title
 *       都走这里。命中率跌幅达到阈值时记录突变；没有可对照的报文时 cause=unknown。
 */
export async function recordCacheHistoryUsage(
  ctx: Plugin.Context,
  sessionID: string,
  input: CacheUsageInput,
): Promise<void> {
  try {
    await withSessionLock(cacheChains, sessionID, async () => {
      const settings = await loadServerSettings(ctx)
      const tracker = dropTracker()
      if (!settings.cacheDropsEnabled) tracker.forget(sessionID)
      const maxDrops = Math.min(MAX_CACHE_DROPS, settings.cacheDropsMaxRecords)
      const history = await loadCacheHistory(ctx.storage, sessionID, maxDrops)
      // 上一条样本必须在本轮样本追加前取，否则会拿自己跟自己比。
      const previousSample = history.samples.at(-1)
      // 同一毫秒内的连续请求也要保持先后顺序，否则样本排序会按 ID 颠倒。
      const at = Math.max(Date.now(), (previousSample?.at ?? 0) + 1)
      const sample = sampleFromTokens(input.sampleID, input.tokens, at)
      const samples = appendCacheSamples(history.samples, [
        {
          id: sample.messageID,
          type: "assistant",
          time: { created: sample.at },
          tokens: input.tokens,
        },
      ])
      const pair = settings.cacheDropsEnabled ? tracker.consume(sessionID, input.sampleID) : undefined
      const drop =
        pair === undefined || previousSample === undefined
          ? undefined
          : planCacheDrop({
              previousSample,
              sample,
              pair,
              kind: input.kind,
              threshold: settings.cacheDropsThreshold,
              ...(input.model === undefined ? {} : { model: input.model }),
            })
      const drops = drop === undefined ? history.drops : appendCacheDrop(history.drops, drop, maxDrops)
      const next: CacheHistory = { v: 2, samples, drops }
      if (!cacheHistoryEquals(history, next)) {
        await saveCacheHistory(ctx.storage, sessionID, next)
      }
    })
  } catch {
    // best effort：历史缺失不影响主流程
  }
}

/**
 * 输入：插件上下文 + sessionID + 单 step 的 assistant usage。
 * 输出：无。
 * 预期：tool loop 的后续 step 不触发 context/usage.updated 的完整读取，
 *       用 `session.step.ended` 事件里的 tokens 直接落一条主请求样本。
 */
export async function recordCacheHistoryStep(
  ctx: Plugin.Context,
  sessionID: string,
  input: { readonly messageID: string; readonly tokens: StepTokens },
): Promise<void> {
  await recordCacheHistoryUsage(ctx, sessionID, {
    sampleID: input.messageID,
    kind: "primary",
    tokens: input.tokens,
  })
}

/**
 * 输入：插件上下文 + sessionID。
 * 输出：无；预期：把当前上下文里未记录过的 assistant usage 追加进该会话的历史。
 *       失败只影响历史，不影响压缩与主流程。
 */
export async function recordCacheHistory(ctx: Plugin.Context, sessionID: string): Promise<void> {
  try {
    await withSessionLock(cacheChains, sessionID, async () => {
      const messages = await ctx.session.context({ sessionID })
      const history = await loadCacheHistory(ctx.storage, sessionID)
      const samples = appendCacheSamples(history.samples, messages)
      const next: CacheHistory = { v: 2, samples, drops: history.drops }
      if (!cacheHistoryEquals(history, next)) {
        await saveCacheHistory(ctx.storage, sessionID, next)
      }
    })
  } catch {
    // best effort：历史缺失不影响主界面
  }
}
