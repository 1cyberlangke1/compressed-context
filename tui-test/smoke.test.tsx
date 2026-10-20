import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"

test("renders a text node headlessly", async () => {
  const app = await testRender(() => <text>hello</text>, { width: 20, height: 5 })
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("hello"))
  expect(app.captureCharFrame()).toContain("hello")
})
