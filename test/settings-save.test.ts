import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import { saveSettings } from "../src/compression/settings.ts"
import { normalizeSettings } from "../src/shared/settings.ts"

const cleanup: string[] = []

/** 输入：无；输出：一个只有单层配置文件的临时工作区。预期：写入目标就是该文件。 */
async function workspace(): Promise<{ file: string; layers: string[]; ctx: { location: { directory: string } } }> {
  const dir = await mkdtemp(join(tmpdir(), "cc-models-save-"))
  cleanup.push(dir)
  const file = join(dir, "compressed-context.json")
  return { file, layers: [file], ctx: { location: { directory: dir } } }
}

/** 输入：文件路径；输出：解析后的对象；缺失时返回空对象。 */
async function readJson(file: string): Promise<Record<string, unknown>> {
  const text = await readFile(file, "utf8").catch(() => "{}")
  return JSON.parse(text) as Record<string, unknown>
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("按模型设置的保存", () => {
  test("只写与继承值不同的字段", async () => {
    const { file, layers, ctx } = await workspace()
    const settings = normalizeSettings({
      models: { "google/gemini-3-pro": { triggerPercent: 85, summaryTotalPercent: 50 } },
    })
    await saveSettings(ctx, settings, layers)
    const saved = await readJson(file)
    expect(saved["models"]).toEqual({ "google/gemini-3-pro": { triggerPercent: 85 } })
  })

  test("全部等于继承值时整条不落盘", async () => {
    const { file, layers, ctx } = await workspace()
    const settings = normalizeSettings({ models: { "google/gemini-3-pro": { triggerPercent: 80 } } })
    await saveSettings(ctx, settings, layers)
    const saved = await readJson(file)
    expect(saved["models"]).toBeUndefined()
  })

  test("把值改回继承值会删掉模型键", async () => {
    const { file, layers, ctx } = await workspace()
    await saveSettings(ctx, normalizeSettings({ models: { "google/gemini-3-pro": { triggerPercent: 85 } } }), layers)
    expect((await readJson(file))["models"]).toEqual({ "google/gemini-3-pro": { triggerPercent: 85 } })

    await saveSettings(ctx, normalizeSettings({ models: {} }), layers)
    expect((await readJson(file))["models"]).toBeUndefined()
  })

  test("重置单个字段只删该字段，其余保留", async () => {
    const { file, layers, ctx } = await workspace()
    await saveSettings(
      ctx,
      normalizeSettings({ models: { "google/gemini-3-pro": { triggerPercent: 85, summaryTotalPercent: 40 } } }),
      layers,
    )
    await saveSettings(ctx, normalizeSettings({ models: { "google/gemini-3-pro": { triggerPercent: 85 } } }), layers)
    expect((await readJson(file))["models"]).toEqual({ "google/gemini-3-pro": { triggerPercent: 85 } })
  })
})
