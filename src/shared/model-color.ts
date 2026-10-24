/**
 * 模型品牌色。
 *
 * 输入：模型 id / 提供商 id。
 * 输出：一组颜色，1 个表示纯色，多个表示按字符插值的渐变；未知模型返回 undefined
 *       （由调用方退回主题色）。
 * 预期：按表从上到下匹配，先命中先赢；所以具体关键字（chatglm、mixtral、01-ai）排在泛化词前面。
 */

/** 一组颜色；长度 1 是纯色。 */
export type Tint = readonly string[]

interface TintRule {
  readonly keys: readonly string[]
  readonly stops: Tint
}

const RULES: readonly TintRule[] = [
  // Gemini 星标渐变
  { keys: ["gemini"], stops: ["#4285F4", "#9B72CB", "#D96570"] },
  // Google 四色
  { keys: ["gemma", "google"], stops: ["#4285F4", "#EA4335", "#FBBC05", "#34A853"] },
  // 微软四方块
  { keys: ["phi", "microsoft"], stops: ["#F25022", "#7FBA00", "#00A4EF", "#FFB900"] },
  // Mistral 五段
  { keys: ["mixtral", "codestral", "mistral"], stops: ["#FFD800", "#FFAF00", "#FF8205", "#FA500F", "#E10500"] },
  // Meta 蓝 → 青
  { keys: ["llama", "meta"], stops: ["#0668E1", "#00C6FF"] },
  // 通义紫
  { keys: ["qwen", "tongyi"], stops: ["#615CED", "#A855F7"] },
  // DeepSeek 蓝白
  { keys: ["deepseek"], stops: ["#4D6BFE", "#FFFFFF"] },
  { keys: ["claude", "anthropic"], stops: ["#D97757"] },
  { keys: ["gpt", "openai", "o1", "o3", "o4"], stops: ["#10A37F"] },
  { keys: ["chatglm", "glm", "zhipu"], stops: ["#3B5BFF"] },
  // 月之暗面是黑白调，深色背景取浅灰
  { keys: ["kimi", "moonshot"], stops: ["#BDBDBD"] },
  { keys: ["grok", "xai"], stops: ["#6B7280"] },
  { keys: ["ernie", "baidu"], stops: ["#4A5CFF"] },
  { keys: ["doubao", "seed", "bytedance"], stops: ["#325AB4"] },
  { keys: ["hunyuan", "tencent"], stops: ["#0052D9"] },
  { keys: ["command", "cohere"], stops: ["#39594D", "#4E8F7A"] },
  { keys: ["nova", "amazon"], stops: ["#FF9900"] },
  { keys: ["nemotron", "nvidia"], stops: ["#76B900"] },
  { keys: ["granite", "ibm"], stops: ["#0F62FE"] },
]

/** 输入：模型与提供商 id；输出：颜色序列。预期：模型 id 优先，其次提供商 id，都没有返回 undefined。 */
export function modelTint(modelID: string, providerID?: string): Tint | undefined {
  const haystacks = [modelID.toLowerCase(), (providerID ?? "").toLowerCase()]
  for (const rule of RULES) {
    for (const field of haystacks) {
      if (field.length === 0) continue
      if (rule.keys.some((key) => field.includes(key))) return rule.stops
    }
  }
  return undefined
}

/** 输入：两个 `#RRGGBB` 与比例；输出：插值后的 `#RRGGBB`。预期：比例 0 取左，1 取右。 */
function mixHex(left: string, right: string, ratio: number): string {
  const parse = (hex: string): [number, number, number] => {
    const value = hex.replace("#", "")
    return [
      Number.parseInt(value.slice(0, 2), 16),
      Number.parseInt(value.slice(2, 4), 16),
      Number.parseInt(value.slice(4, 6), 16),
    ]
  }
  const [r1, g1, b1] = parse(left)
  const [r2, g2, b2] = parse(right)
  const mix = (a: number, b: number): number => Math.round(a + (b - a) * ratio)
  const toHex = (value: number): string => value.toString(16).padStart(2, "0")
  return `#${toHex(mix(r1, r2))}${toHex(mix(g1, g2))}${toHex(mix(b1, b2))}`
}

/**
 * 输入：颜色序列 + 位置比例（0..1）。
 * 输出：该位置的颜色。
 * 预期：单色直接返回；多个 stop 时按段线性插值，越界自动钳到两端。
 */
export function gradientAt(stops: Tint, t: number): string {
  const first = stops[0] ?? "#ffffff"
  if (stops.length <= 1) return first
  const clamped = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0
  const scaled = clamped * (stops.length - 1)
  const index = Math.min(stops.length - 2, Math.floor(scaled))
  const left = stops[index] ?? first
  const right = stops[index + 1] ?? first
  return mixHex(left, right, scaled - index)
}

/** 输入：颜色序列 + 第几个字符 + 总字符数；输出：该字符的颜色。预期：单字符取首色。 */
export function tintAt(stops: Tint, index: number, length: number): string {
  if (length <= 1) return stops[0] ?? "#ffffff"
  return gradientAt(stops, index / (length - 1))
}
