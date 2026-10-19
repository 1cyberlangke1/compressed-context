import { describe, expect, it } from "vitest"

import { resolveDatabasePath } from "../src/compression/history.ts"

describe("resolveDatabasePath", () => {
  it("OPENCODE_DB 优先", () => {
    expect(resolveDatabasePath("D:\\data", "D:\\custom\\opencode.db")).toBe("D:\\custom\\opencode.db")
  })

  it("无 env 时用 data 目录 + opencode.db", () => {
    expect(resolveDatabasePath("D:\\data", undefined)).toBe("D:\\data\\opencode.db")
  })
})
