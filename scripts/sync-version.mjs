#!/usr/bin/env bun
/**
 * 输入：package.json，或 `--package` / `--output` 指定的测试路径。
 * 输出：包含 PLUGIN_PACKAGE 与 PLUGIN_VERSION 的 TypeScript 常量文件。
 * 预期：package.json 是唯一手动维护的版本源，生成结果可直接由源码和 TUI 构建使用。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** 输入：参数名；输出：紧随其后的命令行值，未提供时为 undefined。 */
function option(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} 缺少取值`)
  return value
}

/** 输入：package.json 内容；输出：生成器需要的最小元数据。 */
function packageMeta(value) {
  if (typeof value !== "object" || value === null) throw new Error("package.json 必须是对象")
  const record = value
  const name = record["name"]
  const version = record["version"]
  if (typeof name !== "string" || name.trim() === "") throw new Error("package.json name 必须是非空字符串")
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    throw new Error(`package.json version 不是合法版本号：${String(version)}`)
  }
  return { name, version }
}

/** 输入：包名与版本；输出：稳定的 TypeScript 源码。 */
function render({ name, version }) {
  return `/**
 * 自动生成，请勿手改。
 *
 * 输入：package.json 的 name 与 version。
 * 输出：插件包名与当前版本。
 * 预期：发布前运行 \`pnpm sync:version\`；版本号只在 package.json 手动维护。
 */
export const PLUGIN_PACKAGE = ${JSON.stringify(name)}
export const PLUGIN_VERSION = ${JSON.stringify(version)}
`
}

try {
  const packagePath = option("--package") ?? join(ROOT, "package.json")
  const outputPath = option("--output") ?? join(ROOT, "src/shared/version.ts")
  const meta = packageMeta(JSON.parse(await readFile(packagePath, "utf8")))
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, render(meta), "utf8")
} catch (error) {
  console.error(`版本同步失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
