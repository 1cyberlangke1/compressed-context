import type { Settings } from "../shared/settings.ts"

/** 设置存储的写入函数（`context.storage.store` 的第二个返回值）。 */
export type UpdateSettings = (mutation: (draft: Settings) => void) => Promise<void>
