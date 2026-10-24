/** 输入：任意抛出的值；输出：人话错误文本。预期：RpcError 普通对象也能读出 type + message。 */
export function errorText(error: unknown): string {
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  if (typeof error !== "object" || error === null) return Object.prototype.toString.call(error)
  const record = error as Record<string, unknown>
  const message = typeof record["message"] === "string" ? record["message"] : undefined
  const type = typeof record["type"] === "string" ? record["type"] : undefined
  if (message !== undefined && type !== undefined) return `${type}: ${message}`
  if (message !== undefined) return message
  return JSON.stringify(error)
}
