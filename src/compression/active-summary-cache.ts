import { renderAll, type RenderOptions } from "./render.ts"
import type { State } from "./state.ts"

interface Entry {
  readonly revision: string
  readonly text: string
}

const LIMIT = 32
const cache = new Map<string, Entry>()

/** 输入：状态 + 渲染选项；输出：只由块身份决定的 revision。 */
function revisionOf(state: State, options: RenderOptions): string {
  return JSON.stringify({
    blocks: state.blocks.map((block) => [
      block.id,
      block.tier,
      block.order,
      block.at,
      block.sourceBlockIds ?? [],
    ]),
    pending: state.pending?.id ?? null,
    options,
  })
}

/** 输入：sessionID + 状态 + 渲染选项；输出：活跃摘要文本。 */
export function renderActiveSummary(
  sessionID: string,
  state: State,
  options: RenderOptions,
): string {
  const revision = revisionOf(state, options)
  const hit = cache.get(sessionID)
  if (hit?.revision === revision) return hit.text
  const text = renderAll(state.blocks, state.pending, options)
  cache.delete(sessionID)
  cache.set(sessionID, { revision, text })
  while (cache.size > LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return text
}

/** 输入：sessionID；输出：无；预期：会话删除时丢掉活跃摘要缓存。 */
export function clearActiveSummary(sessionID: string): void {
  cache.delete(sessionID)
}
