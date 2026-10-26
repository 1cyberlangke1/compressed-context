import { describe, expect, it } from "vitest"

import { RGBA } from "@opentui/core"

import { resolveMessages } from "../src/i18n/index.ts"
import type { UpdateCheckResult } from "../src/shared/update.ts"
import { PLUGIN_VERSION } from "../src/shared/version.ts"
import { updateEntryState } from "../src/tui/update-entry.ts"

const COLORS = {
  warning: RGBA.fromInts(255, 193, 7, 255),
  error: RGBA.fromInts(255, 0, 0, 255),
}

describe("更新入口状态", () => {
  it("标题始终包含当前版本", () => {
    const copy = resolveMessages("zh")
    expect(updateEntryState(copy, undefined, COLORS)).toEqual({
      title: `${copy.update.checkUpdates} v${PLUGIN_VERSION}`,
    })
  })

  it("发现新版本时加星标和 warning 色", () => {
    const copy = resolveMessages("en")
    const result: UpdateCheckResult = {
      kind: "update-available",
      currentVersion: PLUGIN_VERSION,
      latestVersion: "9.9.9",
    }
    expect(updateEntryState(copy, result, COLORS)).toEqual({
      title: `${copy.update.checkUpdates} v${PLUGIN_VERSION} *`,
      footer: copy.update.latestFooter("9.9.9"),
      footerColor: COLORS.warning,
    })
  })
})
