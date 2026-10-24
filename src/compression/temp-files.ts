import { createHash, randomUUID } from "node:crypto"
import { readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

/** 临时文件名统一前缀；启动清理只碰这个前缀。 */
export const TEMP_FILE_PREFIX = "compressed-context-"
/** 默认保留 24 小时；设置可以覆盖。 */
export const DEFAULT_TEMP_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000
/** 单次解压默认最多保留多少个文件。 */
export const DEFAULT_TEMP_FILE_CAP = 50

export interface TempFileStoreOptions {
  /** 临时目录；默认 os.tmpdir()。 */
  readonly directory?: string
  /** 文件名前缀；默认 compressed-context-。 */
  readonly prefix?: string
  /** 超过这个年龄的文件会被 sweep 删除；默认 24 小时。 */
  readonly maxAgeMs?: number
  /** 写入后最多保留多少个文件；默认 50。 */
  readonly cap?: number
  /** 当前时间来源；测试可注入固定时钟。 */
  readonly now?: () => number
}

/** 解压临时文件的读写、按会话删除和过期清理。 */
export interface TempFileStore {
  /** 输入：会话 + 块 + 正文 + 上限；输出：临时文件路径。 */
  writeText(sessionID: string, blockID: string, body: string, cap?: number): string
  /** 输入：会话 + 块 + 序号 + base64 + 文件名 + 上限；输出：临时文件路径。 */
  writeMedia(
    sessionID: string,
    blockID: string,
    index: number,
    data: string,
    filename: string | undefined,
    cap?: number,
  ): string
  /** 输入：会话；输出：删除的文件数；预期：跨进程也能按文件名前缀找到该会话的文件。 */
  deleteSession(sessionID: string): number
  /** 输入：无；输出：删除的文件数；预期：只删 mtime 超过 maxAgeMs 的残留文件。 */
  sweep(): number
}

/** 输入：会话；输出：短且稳定的文件名标记；预期：不把原始 sessionID 写进磁盘。 */
function sessionToken(sessionID: string): string {
  return createHash("sha256").update(sessionID).digest("hex").slice(0, 12)
}

/** 输入：任意片段；输出：只含文件系统安全字符的片段。 */
function safePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-")
}

/**
 * 输入：可选的目录/前缀/保留期/上限/时钟。
 * 输出：TempFileStore。
 * 预期：不在内存里维护文件列表；每次按目录前缀扫描，所以进程重启后仍能清理和按会话删除。
 */
export function createTempFileStore(options: TempFileStoreOptions = {}): TempFileStore {
  const directory = options.directory ?? tmpdir()
  const prefix = options.prefix ?? TEMP_FILE_PREFIX
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_TEMP_FILE_MAX_AGE_MS
  const defaultCap = options.cap ?? DEFAULT_TEMP_FILE_CAP
  const now = options.now ?? Date.now

  /** 输入：无；输出：当前目录下匹配前缀的文件路径；目录不可读时返回空数组。 */
  const listFiles = (): string[] => {
    try {
      return readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
        .map((entry) => join(directory, entry.name))
    } catch {
      return []
    }
  }

  /**
   * 输入：会话 ID + 上限。
   * 输出：无。
   * 预期：只淘汰该会话自己的文件，绝不因为一个会话写得太多而删掉别的会话的解压内容。
   */
  const enforceCap = (sessionID: string, cap: number): void => {
    if (cap <= 0) return
    const tokenPrefix = `${prefix}${sessionToken(sessionID)}-`
    const entries: { path: string; mtimeMs: number }[] = []
    for (const path of listFiles()) {
      if (!basename(path).startsWith(tokenPrefix)) continue
      try {
        entries.push({ path, mtimeMs: statSync(path).mtimeMs })
      } catch {
        // 已被外部清理或权限问题：跳过
      }
    }
    if (entries.length <= cap) return
    entries.sort((left, right) => left.mtimeMs - right.mtimeMs)
    for (const entry of entries.slice(0, entries.length - cap)) {
      try {
        unlinkSync(entry.path)
      } catch {
        // best effort
      }
    }
  }

  const writeText = (sessionID: string, blockID: string, body: string, cap = defaultCap): string => {
    const name = `${prefix}${sessionToken(sessionID)}-${safePart(blockID)}-${randomUUID()}.txt`
    const path = join(directory, name)
    writeFileSync(path, body, { encoding: "utf8", mode: 0o600 })
    enforceCap(sessionID, cap)
    return path
  }

  const writeMedia = (
    sessionID: string,
    blockID: string,
    index: number,
    data: string,
    filename: string | undefined,
    cap = defaultCap,
  ): string => {
    const safeName = (filename ?? "").replace(/[^a-zA-Z0-9._-]/g, "-")
    const suffix = safeName.length > 0 ? `-${safeName}` : ""
    const name =
      `${prefix}${sessionToken(sessionID)}-${safePart(blockID)}-media-${index.toString()}` +
      `${suffix}-${randomUUID()}.bin`
    const path = join(directory, name)
    writeFileSync(path, Buffer.from(data, "base64"), { mode: 0o600 })
    enforceCap(sessionID, cap)
    return path
  }

  const deleteSession = (sessionID: string): number => {
    const tokenPrefix = `${prefix}${sessionToken(sessionID)}-`
    let removed = 0
    for (const path of listFiles()) {
      if (!basename(path).startsWith(tokenPrefix)) continue
      try {
        unlinkSync(path)
        removed += 1
      } catch {
        // best effort
      }
    }
    return removed
  }

  const sweep = (): number => {
    const cutoff = now() - maxAgeMs
    let removed = 0
    for (const path of listFiles()) {
      try {
        if (statSync(path).mtimeMs >= cutoff) continue
        unlinkSync(path)
        removed += 1
      } catch {
        // best effort
      }
    }
    return removed
  }

  return { writeText, writeMedia, deleteSession, sweep }
}
