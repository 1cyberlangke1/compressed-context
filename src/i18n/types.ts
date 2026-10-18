import type { CategoryKey } from "../stats.ts"

/** 面板文案：标题、分类标签、估算后缀。 */
export interface Messages {
  readonly title: string
  readonly labels: Readonly<Record<CategoryKey, string>>
  readonly approximate: string
}
