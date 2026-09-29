/**
 * 运行配置。
 *
 * 两套来源:
 *   .env                    启动时的默认值
 *   workspace/settings.json 界面里保存的覆盖,优先级更高,重启后仍生效
 * 这样用户配一次模型(尤其 API key)之后,重启服务也不需要再配。
 *
 * `--require-key` 用于 CLI / CI 场景:缺 key 时直接报错退出,而不是等第一次请求失败。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  mergeProviderConfig,
  validatePersistedSettings,
  DEFAULT_REASONING,
  isReasoningEffort,
  isThinkingFormat,
  type PersistedSettings,
  type ReasoningSettings,
} from "./settings.js";
import type { ProviderConfig, ThinkingFormat } from "./core/provider/types.js";
import type { ObsidianSettings } from "./learn/obsidian.js";

export interface AppConfig {
  provider: ProviderConfig;
  workspaceRoot: string;
  port: number;
  maxIterations: number;
  /** 模型的上下文窗口。压缩阈值由它推导。 */
  contextWindow: number;
  /**
   * 单次回复的输出上限。
   *
   * 默认给到 32768 而不是常见的 8192:开启 thinking 的模型（DeepSeek V4 系列、
   * Claude 的扩展思考）会先花掉大量 token 在思考上,预算给小了会一个字正文都不剩,
   * 表现为「模型没有回复」——而请求本身是成功的,很难定位。
   */
  maxOutputTokens: number;
  /** 各角色的推理强度，来自 workspace/settings.json 或默认值 */
  reasoning: Required<ReasoningSettings>;
  /** thinking 字段的 wire 形态 */
  thinkingFormat: ThinkingFormat;
  /** Obsidian 导出配置；没填路径就表示不导出 */
  obsidian: ObsidianSettings;
}

export function loadConfig(projectRoot: string): AppConfig {
  loadDotEnv(join(projectRoot, ".env"));

  const env = process.env;
  const kind = (env.LEARN_AGENT_PROVIDER ?? "anthropic").toLowerCase();
  if (kind !== "anthropic" && kind !== "openai" && kind !== "mock") {
    throw new Error(
      `LEARN_AGENT_PROVIDER 必须是 anthropic / openai / mock，收到：${kind}`,
    );
  }

  const workspaceRoot = env.LEARN_AGENT_WORKSPACE ?? join(projectRoot, "workspace");

  // 演示模式不需要 key，方便在配 key 之前先把界面和流程跑通
  let base: AppConfig;
  if (kind === "mock") {
    base = {
      provider: { kind, model: "mock-demo", apiKey: "" },
      workspaceRoot,
      port: Number(env.LEARN_AGENT_PORT ?? 8787),
      maxIterations: Number(env.LEARN_AGENT_MAX_ITERATIONS ?? 40),
      contextWindow: Number(env.LEARN_AGENT_CONTEXT_WINDOW ?? 200_000),
      maxOutputTokens: Number(env.LEARN_AGENT_MAX_TOKENS ?? 32_768),
      reasoning: { ...DEFAULT_REASONING },
      thinkingFormat: "auto",
      obsidian: {},
    };
  } else {
    const apiKey =
      kind === "anthropic"
        ? env.LEARN_AGENT_API_KEY ?? env.ANTHROPIC_API_KEY
        : env.LEARN_AGENT_API_KEY ?? env.OPENAI_API_KEY;

    // 只在命令行启动时报错：cn 环境走 UI 配置，此时没有 key 是正常的，
    // 应该由用户在设置页填，而不是让服务起不来。
    if (!apiKey) {
      console.warn(
        `[learn-agent] 未配置 ${kind === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"}，` +
          "启动进入默认模式。带上 `--require-key` 在缺 key 时报错退出；" +
          "或到界面右上角「设置」里填入 API key。",
      );
    }

    const defaultModel = kind === "anthropic" ? "claude-sonnet-4-5" : "gpt-4o";

    base = {
      provider: {
        kind,
        model: env.LEARN_AGENT_MODEL ?? defaultModel,
        apiKey: apiKey ?? "",
        ...(env.LEARN_AGENT_BASE_URL ? { baseUrl: env.LEARN_AGENT_BASE_URL } : {}),
        // OpenAI 兼容服务若不吃 Anthropic 风格的 cache_control，把它关掉
        enableCaching: env.LEARN_AGENT_CACHING !== "off",
      },
      workspaceRoot,
      port: Number(env.LEARN_AGENT_PORT ?? 8787),
      maxIterations: Number(env.LEARN_AGENT_MAX_ITERATIONS ?? 40),
      contextWindow: Number(env.LEARN_AGENT_CONTEXT_WINDOW ?? 200_000),
      maxOutputTokens: Number(env.LEARN_AGENT_MAX_TOKENS ?? 32_768),
      reasoning: { ...DEFAULT_REASONING },
      thinkingFormat: "auto",
      obsidian: {},
    };
  }

  const config = applyPersistedOverrides(base);

  // 非交互场景（CLI / CI）常用 --require-key 强制校验，这时缺 key 直接报错退出。
  if (process.argv.includes("--require-key")) {
    const invalid = validatePersistedSettings(
      { kind: config.provider.kind, model: config.provider.model },
      config.provider,
    );
    if (invalid) {
      console.error(`[learn-agent] 配置校验失败：${invalid}`);
      process.exit(1);
    }
  }

  return config;
}

/** 用 workspace/settings.json 里的界面保存值覆盖 .env 默认。 */
function applyPersistedOverrides(config: AppConfig): AppConfig {
  const persisted = loadPersistedSettings(config.workspaceRoot);
  if (!persisted) return config;

  if (persisted.provider) {
    const merged = mergeProviderConfig(config.provider, persisted.provider);
    const invalid = validatePersistedSettings(persisted.provider, merged);
    if (invalid) {
      throw new Error(
        `workspace/settings.json 里的 provider 配置无效：${invalid}` +
          "\n请修正设置文件后再启动，或删除它以恢复默认。",
      );
    }
    config.provider = merged;
  }

  // thinking 形态是 provider 级的连接事实，随 provider 一起生效
  if (config.thinkingFormat !== "auto") {
    config.provider.thinkingFormat = config.thinkingFormat;
  }

  if (persisted.reasoning) {
    if (isReasoningEffort(persisted.reasoning.planner)) {
      config.reasoning.planner = persisted.reasoning.planner;
    }
    if (isReasoningEffort(persisted.reasoning.tutor)) {
      config.reasoning.tutor = persisted.reasoning.tutor;
    }
  }
  if (isThinkingFormat(persisted.thinkingFormat)) {
    config.thinkingFormat = persisted.thinkingFormat;
  }
  if (persisted.obsidian) {
    config.obsidian = { ...persisted.obsidian };
  }

  if (typeof persisted.contextWindow === "number" && Number.isFinite(persisted.contextWindow)) {
    config.contextWindow = Math.max(
      8000,
      Math.min(2_000_000, Math.floor(persisted.contextWindow)),
    );
  }

  return config;
}

function loadPersistedSettings(root: string): PersistedSettings | null {
  const path = join(root, "settings.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PersistedSettings;
  } catch {
    console.warn(`[learn-agent] settings.json 无法解析，已忽略。`);
    return null;
  }
}

/** 极简 .env 解析。已经存在的环境变量优先，不覆盖。 */
function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) process.env[key] = value;
  }
}