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
    description: "Open plugin settings",
    group: "Plugins",
  },
  settings: {
    title: "Compressed context plugin settings",
    show: "Show panel",
    limit: "Context limit",
    limitAuto: "Model native",
    limitCustom: "Custom…",
    limitHint: "Digits, or a k/m suffix (e.g. 200000, 200k, 1m)",
    limitInvalid: "Enter a valid token count",
    limitHelp: "Enter to confirm · Esc to cancel",
    limitPlaceholder: "200k",
    limitPreview: (value) => `= ${value} tokens`,
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
