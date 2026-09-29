/**
 * 界面可配置的运行设置。
 *
 * 存在 workspace/settings.json 里,优先级高于 .env:启动时先读 .env 作为默认,
 * 若 settings.json 存在则用它的值覆盖。这样用户改了配置后即使重启服务也仍然生效,
 * 而且在 UI 里就能改,不需要碰文件。
 *
 * 注意:apiKey 会以明文存进 settings.json(本地单用户工具)。GET 接口永远只回
 * hasApiKey + 打码后的值,前端展示用;完整 key 只在保存时从表单传进来。
 */

import type {
  ProviderConfig,
  ReasoningEffort,
  ThinkingFormat,
} from "./core/provider/types.js";
import type { ObsidianSettings } from "./learn/obsidian.js";

export type ProviderKind = "anthropic" | "openai" | "mock";

export interface PersistedProviderSettings {
  kind: ProviderKind;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * 各角色的推理强度。
 *
 * 分开设而不是全局一个开关，因为这两类工作对「想多久」的需求正好相反：
 * 规划师在拆解大纲、判断依赖顺序，是典型的多步推理，值得多花思考；
 * 导师多数时候是在讲解一个已经想清楚的概念、回应一个具体疑问，想太久只是更慢更贵。
 */
export interface ReasoningSettings {
  planner?: ReasoningEffort;
  tutor?: ReasoningEffort;
}

export interface PersistedSettings {
  provider: PersistedProviderSettings;
  contextWindow?: number;
  reasoning?: ReasoningSettings;
  /** thinking 字段的 wire 形态，默认 auto */
  thinkingFormat?: ThinkingFormat;
  /** Obsidian 导出配置 */
  obsidian?: ObsidianSettings;
}

/**
 * 默认强度。两个角色都给 high 而不是 max：
 * high 是服务商调过的甜点位置，max 的边际收益很小而延迟和费用明显上升。
 */
export const DEFAULT_REASONING: Required<ReasoningSettings> = {
  planner: "high",
  tutor: "high",
};

export const REASONING_LABELS: Record<ReasoningEffort, string> = {
  off: "关闭（最快最省）",
  low: "低（适合简单任务）",
  high: "高（默认，推荐）",
  max: "最高（最慢最贵，边际收益小）",
};

export const REASONING_VALUES: ReasoningEffort[] = ["off", "low", "high", "max"];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "off" || value === "low" || value === "high" || value === "max";
}

export function isThinkingFormat(value: unknown): value is ThinkingFormat {
  return value === "auto" || value === "deepseek" || value === "openai" || value === "none";
}

export const SETTINGS_FILE = "settings.json";

/** Provider 枚举,同时做运行时校验。 */
export function isProviderKind(value: unknown): value is ProviderKind {
  return value === "anthropic" || value === "openai" || value === "mock";
}

export const PROVIDER_KIND_LABELS: Record<ProviderKind, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI 兼容",
  mock: "演示模式（桩数据，不联网）",
};

/**
 * 合并 .env 默认与界面覆盖。
 *
 * 三个细节:
 * - apiKey 为空字符串表示「不改」——前端在已有 key 时留空输入框,保存时不该把
 *   现有的 key 抹掉。
 * - mock 模式忽略 key 和 baseUrl,避免用户切回 mock 时残留的 key 干扰判断。
 * - baseUrl 对两种真实模式都保留:anthropic 也可能走自定义网关。
 */
export function mergeProviderConfig(
  env: ProviderConfig,
  overrides: PersistedProviderSettings | undefined,
): ProviderConfig {
  if (!overrides) return env;

  const kind = overrides.kind;
  const result: ProviderConfig = { kind, model: overrides.model ?? env.model, apiKey: "" };

  if (kind === "mock") {
    return result;
  }

  // 显式传空字符串 = 不想改;没传 = 用界面已保存的;都没有才落回 .env
  const apiKey =
    overrides.apiKey !== undefined && overrides.apiKey !== "" ? overrides.apiKey : env.apiKey;
  result.apiKey = apiKey ?? "";
  if (overrides.baseUrl !== undefined && overrides.baseUrl !== "") {
    result.baseUrl = overrides.baseUrl;
  } else if (overrides.baseUrl === undefined && env.baseUrl) {
    result.baseUrl = env.baseUrl;
  }
  if (env.enableCaching !== undefined && overrides.apiKey === undefined) {
    result.enableCaching = env.enableCaching;
  }
  if (env.thinkingFormat !== undefined) {
    result.thinkingFormat = env.thinkingFormat;
  }
  return result;
}

/** 打码:前 4 + **** + 后 4。短 key 全打。 */
export function maskApiKey(key: string): string {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

export function clampContextWindow(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  // 下限 8000:窗口小于这个数,一条带工具定义的请求都塞不下
  return Math.max(8000, Math.min(2_000_000, Math.floor(value)));
}

/**
 * 校验界面提交的配置。返回错误信息表示不可用。
 *
 * 延迟到最后一步才校验的原因:false 报警比漏报更糟——key 可能只是环境变量里
 * 有而没提交,baseUrl 可能是合法的自定义网关。所以理想校验是「真的发一次最小请求」,
 * 但那是可选动作(probe),这里只做结构性检查,保证「要么报错要么一定能建出 provider」。
 */
export function validatePersistedSettings(
  settings: PersistedProviderSettings,
  merged: ProviderConfig,
): string | null {
  if (!isProviderKind(settings.kind)) {
    throw new Error(`未知的 provider 类型:${String(settings.kind)}`);
  }

  if (settings.kind === "mock") return null;

  if (!merged.apiKey) {
    return "缺少 API key。在下面填入,或确认 .env 里已配置。";
  }

  const model = settings.model?.trim() ?? "";
  if (settings.kind === "anthropic" && !model) {
    return "Anthropic 模式下需要提供模型名,例如 claude-sonnet-4-5 或 claude-haiku-4-5。";
  }
  return null;
}