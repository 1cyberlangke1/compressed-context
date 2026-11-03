import { existsSync, watch, type FSWatcher } from "node:fs"
import { basename, dirname, resolve } from "node:path"

/** 默认文件变更防抖时间（毫秒）。 */
const DEFAULT_DEBOUNCE_MS = 100

/** 忽略本进程自身写入的有效期（毫秒）。 */
const SELF_SAVED_TTL_MS = 1000

/** 配置文件监听器选项。 */
export interface SettingsWatcherOptions {
  /** 要监听的配置文件绝对路径列表。 */
  readonly files: readonly string[]
  /** 配置文件发生改变（非本进程写入）时的回调。 */
  readonly onChange: (changedPath: string) => void | Promise<void>
  /** 防抖等待毫秒数；默认 100ms。 */
  readonly debounceMs?: number | undefined
}

/** 配置文件监听器句柄。 */
export interface SettingsWatcher {
  /** 标记某个文件刚刚由本进程写入，忽略近期内的变动事件。 */
  markSelfSaved(filePath: string): void
  /** 释放所有目录监听器并清理定时器。 */
  dispose(): void
}

function nearestExistingDir(dir: string): string | undefined {
  let current = resolve(dir)
  for (;;) {
    if (existsSync(current)) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * 监听一组配置文件所在目录的变动。
 *
 * 输入：目标文件路径、变动回调、可选防抖时间。
 * 输出：带有 markSelfSaved 与 dispose 的监听句柄。
 * 预期：
 *   1. 提取所有目标文件的 dirname 去重，在存在的目录（或最近的已存在父目录）上挂载 fs.watch。
 *   2. 匹配 basename 或新创建的子目录，防抖合并多次系统事件（如重命名、多次写入）。
 *   3. 过滤本进程 markSelfSaved 的事件，避免自回环。
 */
export function watchConfigFiles(options: SettingsWatcherOptions): SettingsWatcher {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const targetFiles = new Map<string, string>() // resolved path -> basename
  const targetDirs = new Set<string>()
  const watchDirs = new Set<string>()
  const selfSavedAt = new Map<string, number>()

  for (const file of options.files) {
    const fullPath = resolve(file)
    const name = basename(fullPath)
    const dir = dirname(fullPath)
    targetFiles.set(fullPath, name)
    targetDirs.add(dir)
    const existing = nearestExistingDir(dir)
    if (existing !== undefined) watchDirs.add(existing)
  }

  const watchers: FSWatcher[] = []
  let timer: NodeJS.Timeout | undefined
  let pendingFile: string | undefined

  const triggerChange = (): void => {
    timer = undefined
    const file = pendingFile
    pendingFile = undefined
    if (file === undefined) return
    void options.onChange(file)
  }

  for (const dir of watchDirs) {
    try {
      const watcher = watch(dir, { persistent: false }, (_eventType, filename) => {
        if (typeof filename !== "string" || filename.length === 0) return

        // 匹配是否属于我们关注的目标文件
        let matchedPath: string | undefined
        for (const [fullPath, name] of targetFiles.entries()) {
          if (name.toLowerCase() === filename.toLowerCase()) {
            matchedPath = fullPath
            break
          }
        }

        // 如果不是直接匹配文件名，检查是否有新目录被创建导致目标文件现已存在
        if (matchedPath === undefined) {
          for (const fullPath of targetFiles.keys()) {
            if (existsSync(fullPath)) {
              matchedPath = fullPath
              break
            }
          }
        }

        if (matchedPath === undefined) return

        // 检查是否属于本进程自身保存触发
        const lastSaved = selfSavedAt.get(matchedPath)
        if (lastSaved !== undefined && Date.now() - lastSaved < SELF_SAVED_TTL_MS) {
          return
        }

        pendingFile = matchedPath
        if (timer !== undefined) clearTimeout(timer)
        timer = setTimeout(triggerChange, debounceMs)
      })
      watchers.push(watcher)
    } catch {
      // 目录无权限或不支持监听时静默忽略，不崩溃
    }
  }

  return {
    markSelfSaved(filePath: string): void {
      selfSavedAt.set(resolve(filePath), Date.now())
    },
    dispose(): void {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      for (const watcher of watchers) {
        try {
          watcher.close()
        } catch {
          // ignore
        }
      }
      watchers.length = 0
    },
  }
}
