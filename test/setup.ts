import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// 测试隔离：全局配置目录指向临时目录，避免读到本机真实插件配置。
process.env["OPENCODE_TEST_HOME"] = mkdtempSync(join(tmpdir(), "cc-test-home-"))
