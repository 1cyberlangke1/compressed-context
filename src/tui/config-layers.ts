import type { Context } from "@opencode/plugin/tui/context"
import { basename, join } from "node:path"

import { CONFIG_FILE, fallbackConfigFiles, globalConfigDirectory } from "../shared/config-paths.ts"

/**
 * 输入：TUI 上下文。
 * 输出：插件配置层路径，全局在前，项目由远到近。
 * 预期：项目 `.opencode` 目录直接取 OpenCode 的 config.get 结果，不再自己判断项目根；
 *       config.get 失败时回退到全局 + 向上查找 `.opencode`。
 */
export async function configFileLayers(context: Context): Promise<string[]> {
  const directory = context.location?.directory
  try {
    const entries = await context.client.config.get(
      directory === undefined ? undefined : { location: { directory } },
    )
    const project = entries
      .filter((entry) => entry.type === "directory")
      .map((entry) => entry.path)
      .filter((path) => basename(path) === ".opencode")
      .map((path) => join(path, CONFIG_FILE))
    return [join(globalConfigDirectory(), CONFIG_FILE), ...new Set(project)]
  } catch {
    return directory === undefined
      ? [join(globalConfigDirectory(), CONFIG_FILE)]
      : fallbackConfigFiles(directory)
  }
}
