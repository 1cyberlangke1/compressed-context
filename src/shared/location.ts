/** 插件做归属判断所需的最小 location 形状。 */
export interface LocationLike {
  readonly directory: string
  readonly workspaceID?: string | undefined
}

/**
 * 输入：两个 location（可为 undefined）。
 * 输出：是否属于同一 location。
 * 预期：directory 与 workspaceID 都严格相等才为 true；任一侧缺失一律 false。
 *       宿主按 `Location.Ref = directory + workspaceID` 分配实例，只比目录会把
 *       同目录不同 workspace 的两个实例认成同一个，导致重复记账。
 */
export function sameLocation(
  left: LocationLike | undefined,
  right: LocationLike | undefined,
): boolean {
  if (left === undefined || right === undefined) return false
  return left.directory === right.directory && left.workspaceID === right.workspaceID
}
