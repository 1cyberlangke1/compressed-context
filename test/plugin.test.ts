import { describe, expect, it } from "vitest"

import plugin from "../src/index.ts"

describe("插件入口", () => {
  it("导出可被 OpenCode 识别的插件定义", () => {
    expect(plugin.id).toBe("compressed-context")
    expect(typeof plugin.setup).toBe("function")
  })
})
