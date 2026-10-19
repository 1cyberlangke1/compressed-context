import { describe, expect, it } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { openHistoryDb, readSessionRows } from "../src/compression/history.ts"

/** 建一张与 2.0.32 同构的 session_message 表并塞数据。 */
function seedDb(path: string, rows: readonly { id: string; type: string; seq: number; data: string }[]) {
  const db = new DatabaseSync(path)
  db.exec(`create table session_message (
    id text primary key,
    session_id text not null,
    type text not null,
    seq integer not null,
    time_created integer not null,
    time_updated integer not null,
    data text not null
  )`)
  const insert = db.prepare(
    "insert into session_message (id, session_id, type, seq, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?, ?)",
  )
  for (const row of rows) insert.run(row.id, "ses_x", row.type, row.seq, 0, 0, row.data)
  db.close()
}

describe("openHistoryDb / readSessionRows", () => {
  it("只读打开并按 session 取升序行", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-history-"))
    try {
      const path = join(dir, "opencode.db")
      seedDb(path, [
        { id: "msg_1", type: "user", seq: 1, data: JSON.stringify({ id: "msg_1", type: "user", text: "hi" }) },
        { id: "msg_2", type: "assistant", seq: 2, data: JSON.stringify({ id: "msg_2", type: "assistant", content: [{ type: "text", text: "yo" }] }) },
      ])
      const db = openHistoryDb(path)
      try {
        const rows = readSessionRows(db, "ses_x")
        expect(rows.map((row) => row.id)).toEqual(["msg_1", "msg_2"])
        expect(rows[0]?.data).toContain("hi")
      } finally {
        db.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("坏行不阻断读取（readSessionRows 不解码 data）", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-history-"))
    try {
      const path = join(dir, "opencode.db")
      seedDb(path, [
        { id: "msg_1", type: "user", seq: 1, data: "{broken" },
        { id: "msg_2", type: "user", seq: 2, data: JSON.stringify({ id: "msg_2", type: "user", text: "ok" }) },
      ])
      const db = openHistoryDb(path)
      try {
        expect(readSessionRows(db, "ses_x").map((row) => row.id)).toEqual(["msg_1", "msg_2"])
      } finally {
        db.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("文件不存在时抛出错误", () => {
    expect(() => openHistoryDb(join(tmpdir(), "cc-missing-xyz", "opencode.db"))).toThrow()
  })

  it("只读连接拒绝写入", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-history-"))
    try {
      const path = join(dir, "opencode.db")
      seedDb(path, [])
      const db = openHistoryDb(path)
      try {
        expect(() => db.prepare("insert into session_message (id) values ('x')").run()).toThrow()
      } finally {
        db.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
