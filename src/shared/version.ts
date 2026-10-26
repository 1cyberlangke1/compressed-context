/**
 * npm 包名。
 *
 * 输入：无。
 * 输出：`compressed-context`。
 * 预期：与 package.json 的 `name` 一致；更新命令和 registry 查询都用它，
 *       改名后单测会变红，避免命令指向旧包。
 */
export const PLUGIN_PACKAGE = "compressed-context"

/**
 * 当前插件版本。
 *
 * 输入：无。
 * 输出：`0.2.24`。
 * 预期：与 package.json 的 `version` 一致；发版递增版本号时必须同步这里，
 *       否则单测会变红，避免 TUI 显示的版本落后于实际安装包。
 */
export const PLUGIN_VERSION = "0.2.24"
