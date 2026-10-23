import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser"

/** 配置文件根对象；只接受 JSON 对象。 */
export type ConfigValues = Record<string, unknown>

/** 单个配置文件的读取错误。 */
export interface ConfigError {
  readonly path: string
  readonly message: string
}

/** 多层配置合并结果；errors 中的层被跳过，不阻断其他层。 */
export interface ConfigReadResult {
  readonly values: ConfigValues
  readonly errors: readonly ConfigError[]
}

/** 写入结果；失败时 error 可直接展示。 */
export type ConfigWriteResult = { readonly ok: true } | { readonly ok: false; readonly error: string }

/** 输入：任意值；输出：是否是普通对象。 */
function isRecord(value: unknown): value is ConfigValues {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** 输入：未知异常；输出：是否 ENOENT。 */
function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

/** 输入：未知异常；输出：人类可读消息。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 输入：JSONC 文本 + 路径；输出：对象或解析错误。 */
function parseConfig(text: string, path: string): { readonly value?: ConfigValues; readonly error?: ConfigError } {
  const errors: ParseError[] = []
  const parsed: unknown = parse(text, errors, { allowTrailingComma: true })
  const first = errors[0]
  if (first !== undefined) {
    return {
      error: {
        path,
        message: `JSONC parse failed: ${printParseErrorCode(first.error)} at ${first.offset.toString()}`,
      },
    }
  }
  if (!isRecord(parsed)) {
    return { error: { path, message: "config root must be a JSON object" } }
  }
  return { value: parsed }
}

/** 输入：文件路径；输出：解析后的对象，缺失视为空对象。 */
async function readConfigFile(path: string): Promise<{ readonly value?: ConfigValues; readonly error?: ConfigError }> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if (isNotFound(error)) return { value: {} }
    return { error: { path, message: errorMessage(error) } }
  }
  return parseConfig(text, path)
}

/** 输入：下层 + 上层；输出：深合并结果。预期：对象递归合并，数组与标量整体替换。 */
function mergeConfig(base: ConfigValues, next: ConfigValues): ConfigValues {
  const result: ConfigValues = { ...base }
  for (const [key, value] of Object.entries(next)) {
    const previous = result[key]
    result[key] = isRecord(previous) && isRecord(value) ? mergeConfig(previous, value) : value
  }
  return result
}

/**
 * 输入：配置路径（低→高优先级）。
 * 输出：合并后的对象与每个坏层的错误。
 * 预期：缺失文件跳过；解析失败的层跳过，不让一个坏文件清空全部设置。
 */
export async function readMergedConfig(paths: readonly string[]): Promise<ConfigReadResult> {
  let values: ConfigValues = {}
  const errors: ConfigError[] = []
  for (const path of paths) {
    const read = await readConfigFile(path)
    if (read.error !== undefined) {
      errors.push(read.error)
      continue
    }
    if (read.value !== undefined) values = mergeConfig(values, read.value)
  }
  return { values, errors }
}

/** 输入：两个值；输出：是否深度相等。预期：只用于设置里的 JSON 值。 */
function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => deepEqual(value, right[index]))
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left)
    if (leftKeys.length !== Object.keys(right).length) return false
    return leftKeys.every((key) => key in right && deepEqual(left[key], right[key]))
  }
  return false
}

/**
 * 输入：当前值 + 目标值。
 * 输出：只包含变化键的补丁；没有变化返回 undefined。
 * 预期：对象递归比较，数组整体替换；缺失键也写入。
 */
export function diffConfig(current: ConfigValues, next: ConfigValues): ConfigValues | undefined {
  const patch: ConfigValues = {}
  for (const [key, value] of Object.entries(next)) {
    const previous = current[key]
    if (deepEqual(previous, value)) continue
    if (isRecord(previous) && isRecord(value)) {
      const nested = diffConfig(previous, value)
      if (nested !== undefined) patch[key] = nested
      continue
    }
    patch[key] = value
  }
  return Object.keys(patch).length === 0 ? undefined : patch
}

/** 输入：补丁；输出：叶子路径列表。预期：用于 jsonc-parser 逐键修改。 */
function flattenPatch(patch: ConfigValues, prefix: readonly string[] = []): { path: string[]; value: unknown }[] {
  const leaves: { path: string[]; value: unknown }[] = []
  for (const [key, value] of Object.entries(patch)) {
    const path = [...prefix, key]
    if (isRecord(value) && Object.keys(value).length > 0) {
      leaves.push(...flattenPatch(value, path))
      continue
    }
    leaves.push({ path, value })
  }
  return leaves
}

/**
 * 输入：配置文件路径 + 只含变化键的补丁。
 * 输出：成功或错误。
 * 预期：保留注释与格式；解析失败绝不覆盖；先写临时文件再替换。
 */
export async function writeConfigValues(path: string, patch: ConfigValues): Promise<ConfigWriteResult> {
  if (Object.keys(patch).length === 0) return { ok: true }

  const read = await readConfigFile(path)
  if (read.error !== undefined) return { ok: false, error: read.error.message }

  let text = read.value === undefined ? "{}" : await readText(path)
  for (const leaf of flattenPatch(patch)) {
    text = applyEdits(
      text,
      modify(text, leaf.path, leaf.value, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }),
    )
  }

  try {
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid.toString()}.${Date.now().toString()}.tmp`
    await writeFile(temp, text, "utf8")
    try {
      await rename(temp, path)
    } catch {
      // Windows 上目标已存在时 rename 可能失败：退回复制后删除临时文件。
      await copyFile(temp, path)
      await rm(temp, { force: true })
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

/** 输入：路径；输出：原文本；缺失返回 `{}`。预期：只用于已确认可解析的文件。 */
async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if (isNotFound(error)) return "{}"
    throw error
  }
}

/** 输入：低→高路径；输出：最接近的高优先级已存在文件；都不存在返回第一个（全局）。 */
export async function nearestExistingConfig(paths: readonly string[]): Promise<string | undefined> {
  for (let index = paths.length - 1; index >= 0; index -= 1) {
    const path = paths[index]
    if (path === undefined) continue
    try {
      await stat(path)
      return path
    } catch {
      // 不存在：继续往低优先级找
    }
  }
  return paths[0]
}
