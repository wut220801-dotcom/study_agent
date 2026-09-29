/**
 * 把主项目的 agent 运行时装配成插件可用的形态。
 *
 * 这里是「全部跑在插件里」的落点：没有服务端、没有 HTTP、没有 SSE，
 * 插件进程内直接持有 LearningRuntime，一轮对话就是一次函数调用。
 *
 * 复用策略：`src/core/` 和 `src/learn/` 一行不改地 import 进来。它们本来就不知道
 * 自己被谁调用——这是当初分层的红利。唯一需要适配的是提示词加载（打包后没有源码
 * 目录，见下方 injectPrompts）和配置来源（不再读 .env，改用插件设置）。
 */

import { FileSystemAdapter, type App } from "obsidian";

import type { AppConfig } from "../../src/config.js";
import type { ProviderConfig, ReasoningEffort, ThinkingFormat } from "../../src/core/provider/types.js";
import { setPromptOverrides } from "../../src/learn/prompts.js";
import { LearningRuntime } from "../../src/learn/runtime.js";
import type { CustomRole } from "../../src/learn/roles.js";
import { DEFAULT_REASONING, type ReasoningSettings } from "../../src/settings.js";

// esbuild 的 text loader 把提示词作为字符串打进产物
import compressPrompt from "../../src/learn/prompts/compress.md";
import plannerPrompt from "../../src/learn/prompts/planner.md";
import tutorPrompt from "../../src/learn/prompts/tutor.md";

/** 插件设置。存在 Obsidian 的 plugin data 里（data.json）。 */
export interface LearnAgentSettings {
  providerKind: "anthropic" | "openai" | "mock";
  model: string;
  apiKey: string;
  baseUrl: string;
  contextWindow: number;
  maxOutputTokens: number;
  reasoning: Required<ReasoningSettings>;
  thinkingFormat: ThinkingFormat;
  /** 学习笔记导出到库里的哪个文件夹 */
  notesFolder: string;
  /** 每轮结束后自动把笔记写进库里 */
  autoWriteNotes: boolean;
  /** 用户自己加的对话角色 */
  customRoles: CustomRole[];
}

export const DEFAULT_SETTINGS: LearnAgentSettings = {
  providerKind: "anthropic",
  model: "claude-sonnet-4-5",
  apiKey: "",
  baseUrl: "",
  contextWindow: 200_000,
  maxOutputTokens: 32_768,
  reasoning: { ...DEFAULT_REASONING },
  thinkingFormat: "auto",
  notesFolder: "学习Agent",
  autoWriteNotes: true,
  customRoles: [],
};

/**
 * 提示词注入。必须在任何一次 agent 调用之前执行一次。
 * 打包产物的 import.meta.url 指不到 .md 文件，所以从这里把内容送进去。
 */
let promptsInjected = false;
function injectPrompts(): void {
  if (promptsInjected) return;
  setPromptOverrides({
    tutor: tutorPrompt,
    planner: plannerPrompt,
    compress: compressPrompt,
  });
  promptsInjected = true;
}

/** 库根目录的绝对路径。node 侧的文件操作要靠它拼路径。 */
export function vaultBasePath(app: App): string {
  const adapter = app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) {
    throw new Error("Learn Agent 只支持桌面端 Obsidian");
  }
  return adapter.getBasePath();
}

/**
 * agent 的内部状态目录。
 *
 * 刻意放在插件目录下而不是库的笔记树里：会话记录、精华缓存、注入记录都是 agent 的
 * 运行数据，混进笔记树会把你的文件列表刷满，而且它们不是给你读的笔记。
 * 真正该看到的是导师写的笔记——那些会单独写进库里（见 notesFolder）。
 */
export function stateDir(app: App, manifestDir: string): string {
  return `${vaultBasePath(app)}/${manifestDir}/data`;
}

export function buildRuntimeConfig(
  app: App,
  manifestDir: string,
  settings: LearnAgentSettings,
): AppConfig {
  injectPrompts();

  const provider: ProviderConfig = {
    kind: settings.providerKind,
    model: settings.model,
    apiKey: settings.apiKey,
    ...(settings.baseUrl.trim() ? { baseUrl: settings.baseUrl.trim() } : {}),
    ...(settings.thinkingFormat !== "auto" ? { thinkingFormat: settings.thinkingFormat } : {}),
  };

  return {
    provider,
    // 状态放插件目录，不放笔记树
    workspaceRoot: stateDir(app, manifestDir),
    port: 0, // 插件里没有服务端
    maxIterations: 40,
    contextWindow: settings.contextWindow,
    maxOutputTokens: settings.maxOutputTokens,
    reasoning: settings.reasoning,
    thinkingFormat: settings.thinkingFormat,
    // 插件里不走向量导出那条路——笔记由 view 层在每轮结束后直接写进库，
    // 这样复用 app.vault，Obsidian 的文件索引能立刻感知到。
    obsidian: {},
  };
}

export function createRuntime(
  app: App,
  manifestDir: string,
  settings: LearnAgentSettings,
): LearningRuntime {
  return new LearningRuntime(buildRuntimeConfig(app, manifestDir, settings));
}

export type { ReasoningEffort };
