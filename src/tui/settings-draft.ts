import { normalizeSettings, type Settings } from "../shared/settings.ts"

/**
 * 输入：当前设置（可能是 Solid store 代理）+ 修改函数。
 * 输出：规范化后的新设置。
 * 预期：`models` 必须单独浅拷贝。直接 spread store 时 `draft.models` 仍是 store 的代理，
 *       往代理上写新键会被忽略，保存出去的对象里 `models` 永远是空的。
 */
export function applySettingsMutation(
  settings: Settings,
  mutation: (draft: Settings) => void,
): Settings {
  const draft: Settings = { ...settings, models: { ...settings.models } }
  mutation(draft)
  // 显式收成 Record 再交给归一化，避免 Settings 缺索引签名导致的类型断言。
  const record: Record<string, unknown> = { ...draft }
  return normalizeSettings(record)
}

/**
 * 输入：当前设置。
 * 输出：可安全回滚的快照。
 * 预期：嵌套对象也要断开引用，否则回滚时已被改过的对象会把快照一起改掉。
 */
export function snapshotSettings(settings: Settings): Settings {
  return { ...settings, models: { ...settings.models } }
}
