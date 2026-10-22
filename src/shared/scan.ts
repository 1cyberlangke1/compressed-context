/**
 * 输入：具备 scan 能力的 storage + 前缀 + 每条目的处理函数。
 * 输出：无。
 * 预期：按 next 游标分页遍历全部匹配条目，逐条串行 await，避免一次性把 key 全读进内存。
 */
export interface ScanStorageLike {
  readonly scan?: (options: { prefix: string; limit: number; after?: string }) => Promise<{
    entries: readonly { key: string; value: unknown }[]
    next?: string
  }>
}

/** 输入：storage + 前缀 + 访问函数 + 每页条数；输出：无；预期：storage 无 scan 时直接返回。 */
export async function forEachScannedEntry(
  storage: ScanStorageLike,
  prefix: string,
  visit: (entry: { key: string; value: unknown }) => Promise<void>,
  limit = 100,
): Promise<void> {
  if (storage.scan === undefined) return
  let after: string | undefined
  for (;;) {
    const page = await storage.scan({
      prefix,
      limit,
      ...(after === undefined ? {} : { after }),
    })
    for (const entry of page.entries) await visit(entry)
    if (page.next === undefined) return
    after = page.next
  }
}
