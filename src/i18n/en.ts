import type { Messages } from "./types.ts"

/** English copy. Labels stay short so they fit the narrow sidebar. */
export const en: Messages = {
  title: "Context breakdown",
  labels: {
    system: "System",
    tools: "Tool defs",
    tool: "Tool I/O",
    text: "Text",
    summaries: "Summary",
    media: "Media",
  },
  approximate: "~",
  command: {
    title: "Compressed context settings",
    description: "Open context panel settings",
  },
  settings: {
    title: "Context panel settings",
    show: "Show panel",
    limit: "Context limit",
    limitAuto: "Model native",
    limitCustom: "Custom…",
    limitPrompt: "Enter limit (e.g. 200k)",
    limitInvalid: "Invalid context limit",
    language: "Language",
    auto: "Auto",
    on: "On",
    off: "Off",
    close: "Close",
  },
  languages: {
    zh: "中文",
    en: "English",
  },
}
