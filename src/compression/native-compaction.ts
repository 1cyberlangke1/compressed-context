import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser"

/** 写入结果；失败时 error 是可直接展示的原因。 */
export type NativeCompactionWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string }

/** 输入：未知异常；输出：人类可读错误。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 输入：未知异常；输出：是否是 ENOENT。 */
function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

/**
 * 输入：要修改的配置文件路径。
 * 输出：成功或解析/写入错误。
 * 预期：用 jsonc-parser 保留注释和格式；不做备份；解析失败绝不写文件。
 *       放在服务端执行，TUI 插件不直接依赖 jsonc-parser。
 */
export async function disableNativeCompaction(path: string): Promise<NativeCompactionWriteResult> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if (!isNotFound(error)) return { ok: false, error: errorMessage(error) }
    text = "{}"
  }

  const errors: ParseError[] = []
  parse(text, errors, { allowTrailingComma: true })
  const [first] = errors
  if (first !== undefined) {
    return {
      ok: false,
      error: `JSONC parse failed: ${printParseErrorCode(first.error)} at ${first.offset.toString()}`,
    }
  }

  const next = applyEdits(
    text,
    modify(text, ["compaction", "auto"], false, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    }),
  )

  try {
    await mkdir(dirname(path), { recursive: true })
    // 先写同目录临时文件再 rename：进程被杀时不会留下半截配置文件。
    const temp = `${path}.${process.pid.toString()}.${Date.now().toString()}.tmp`
    try {
      await writeFile(temp, next, "utf8")
      await rename(temp, path)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}
