import type { Plugin } from "@opencode/plugin"
import type { Schema } from "effect"

import {
  appendCacheSamples,
  cacheHistoryEquals,
  cacheHistoryKey,
  parseCacheHistory,
  type CacheHistory,
  type CacheSample,
} from "../shared/cache.ts"
import type { StorageLike } from "./state.ts"

/** 输入：storage + sessionID；输出：该会话的历史；缺失或损坏时为空历史。 */
export async function loadCacheHistory(storage: StorageLike, sessionID: string): Promise<CacheHistory> {
  return parseCacheHistory(await storage.get(cacheHistoryKey(sessionID)))
}

/** 输入：storage + sessionID + 样本；输出：无；预期：写入 JSON，最多 10 条。 */
export async function saveCacheHistory(
  storage: StorageLike,
  sessionID: string,
  samples: readonly CacheSample[],
): Promise<void> {
  await storage.set(cacheHistoryKey(sessionID), { v: 1, samples } as unknown as Schema.Json)
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
