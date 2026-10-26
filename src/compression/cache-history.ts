import type { Plugin } from "@opencode/plugin"
import type { Schema } from "effect"

import {
  appendCacheSampleFromStep,
  appendCacheSamples,
  cacheHistoryEquals,
  cacheHistoryKey,
  parseCacheHistory,
  type CacheHistory,
  type CacheSample,
} from "../shared/cache.ts"
import { isSessionDeleted } from "./deleted-sessions.ts"
import type { StorageLike } from "./state.ts"

/** 输入：storage + sessionID；输出：该会话的历史；缺失或损坏时为空历史。 */
export async function loadCacheHistory(storage: StorageLike, sessionID: string): Promise<CacheHistory> {
  return parseCacheHistory(await storage.get(cacheHistoryKey(sessionID)))
}

/**
 * 输入：storage + sessionID + 样本。
 * 输出：无。
 * 预期：写入 JSON，最多 10 条；会话已删除（墓碑命中）时直接跳过，
 *       避免删除后迟到的 step/usage 再写下缓存 key。
 */
export async function saveCacheHistory(
  storage: StorageLike,
  sessionID: string,
  samples: readonly CacheSample[],
): Promise<void> {
  if (isSessionDeleted(sessionID)) return
  await storage.set(cacheHistoryKey(sessionID), { v: 1, samples } as unknown as Schema.Json)
}

/**
 * 输入：插件上下文 + sessionID + 单 step 的 assistant usage。
 * 输出：无。
 * 预期：tool loop 的后续 step 不触发 context/usage.updated 的完整读取，
 *       用 `session.step.ended` 事件里的 tokens 直接落一条缓存样本。
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
    const history = await loadCacheHistory(ctx.storage, sessionID)
    const samples = appendCacheSampleFromStep(history.samples, input.messageID, input.tokens)
    if (!cacheHistoryEquals(history.samples, samples)) {
      await saveCacheHistory(ctx.storage, sessionID, samples)
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
    if (!cacheHistoryEquals(history.samples, samples)) {
      await saveCacheHistory(ctx.storage, sessionID, samples)
    }
  } catch {
    // best effort：历史缺失不影响主界面
  }
}
