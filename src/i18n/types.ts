import type { CategoryKey } from "../stats.ts"

/**
 * 面板文案。
 *
 * 源码里只引用键名，所有用户可见文字都来自语言文件。
 */
export interface Messages {
  readonly title: string
  readonly labels: Readonly<Record<CategoryKey, string>>
  readonly approximate: string
  readonly command: {
    readonly title: string
    readonly description: string
  }
  readonly settings: {
    readonly title: string
    readonly show: string
    readonly limit: string
    readonly limitAuto: string
    readonly limitCustom: string
    readonly limitHint: string
    readonly limitInvalid: string
    readonly limitHelp: string
    readonly language: string
    readonly auto: string
    readonly on: string
    readonly off: string
    readonly close: string
  }
  readonly languages: {
    readonly zh: string
    readonly en: string
  }
}
