/**
 * 运行时配置的持久化与读取。
 *
 * 界面保存的设置写到 workspace/settings.json。这里提供的 API 是：
 *   GET  /api/settings            —— 当前生效的配置（key 打码）
 *   PUT  /api/settings            —— 保存新配置（key 可选：留空=不覆盖已有）
 *   POST /api/settings/probe      —— 测试连接（不保存）
 * 保存后**立即生效**，无需重启。
 */

import { join } from "node:path";
import { Hono } from "hono";
import type { LearningRuntime } from "../learn/runtime.js";
import {
  SETTINGS_FILE,
  isProviderKind,
  isReasoningEffort,
  isThinkingFormat,
  type ReasoningSettings,
  type PersistedProviderSettings,
  type PersistedSettings,
} from "../settings.js";
import { probeProvider } from "./probe.js";
import { inspectVault, type ObsidianSettings } from "../learn/obsidian.js";

export function createSettingsApi(runtime: LearningRuntime): Hono {
  const api = new Hono();

  /** 当前生效配置。只返回打码后的 key。 */
  api.get("/", (c) => {
    const effective = runtime.effectiveProviderConfig();
    const contextWindow = runtime.currentContextWindow();
    // 已保存的设置（是否配过、模型名从表单来）也在响应里,让前端表单初始值正确
    return c.json({
      ...effective,
      contextWindow,
      reasoning: runtime.reasoningSettings(),
      thinkingFormat: runtime.thinkingFormat(),
      obsidian: runtime.obsidianSettings(),
      lastExport: runtime.lastObsidianExport(),
    });
  });

  /**
   * 保存并立即应用。
   * key 字段语义：传非空字符串 = 更新 key；不传或传空串 = 保留现有 key。
   * 校验失败返回 500 而不是 400，因为服务端不响应 body —— 统一走 {error} 文本。
   */
  api.put("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "请求体必须是 JSON 对象" }, 400);
    }
    const raw = body as Record<string, unknown>;

    const settings = extractSendableSettings(raw);
    if (!settings) {
      return c.json({ error: "provider 配置无效：缺少 kind" }, 400);
    }

    // 未显式提交 kind/model 时沿用当前值（只改 key 的场景）
    if (raw.kind === undefined) settings.kind = runtime.currentKind() as never;
    if (raw.model === undefined) settings.model = runtime.currentModel();

    const result = await runtime.reconfigureProvider(settings);
    if (!result.ok) {
      return c.json({ error: result.error }, 500);
    }

    const stored = readStored(runtime);

    // key 的语义：请求里给了非空值才更新；留空表示「不修改」，沿用已保存的。
    // 否则「只想换个模型名」的操作会被当成清空密钥而校验失败。
    const nextProvider: PersistedProviderSettings = {
      kind: settings.kind,
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
      ...(settings.apiKey
        ? { apiKey: settings.apiKey }
        : stored.provider?.apiKey
          ? { apiKey: stored.provider.apiKey }
          : {}),
    };

    const window =
      typeof raw.contextWindow === "number" && Number.isFinite(raw.contextWindow)
        ? raw.contextWindow
        : stored.contextWindow;

    if (window !== undefined) runtime.setContextWindow(window);

    // 推理强度：只接受合法档位，非法值忽略而不是报错——
    // 前端下拉框永远只发合法值，走到了说明是手工调用，静默忽略比中断保存更合理。
    const reasoning: ReasoningSettings = {};
    if (raw.reasoningPlanner !== undefined && isReasoningEffort(raw.reasoningPlanner)) {
      reasoning.planner = raw.reasoningPlanner;
    }
    if (raw.reasoningTutor !== undefined && isReasoningEffort(raw.reasoningTutor)) {
      reasoning.tutor = raw.reasoningTutor;
    }
    runtime.setReasoning(reasoning);

    const thinkingFormat =
      raw.thinkingFormat !== undefined && isThinkingFormat(raw.thinkingFormat)
        ? raw.thinkingFormat
        : stored.thinkingFormat;

    // Obsidian：只接受字符串/布尔，路径做存在性与「是不是库」的检查
    const obsidian: ObsidianSettings = { ...runtime.obsidianSettings() };
    if (typeof raw.obsidianVaultPath === "string") {
      const vaultPath = raw.obsidianVaultPath.trim();
      if (vaultPath) {
        const probe = inspectVault(vaultPath);
        if (!probe.ok) return c.json({ error: probe.error }, 400);
      }
      obsidian.vaultPath = vaultPath;
    }
    if (typeof raw.obsidianFolder === "string") {
      obsidian.folder = raw.obsidianFolder.trim();
    }
    if (typeof raw.obsidianAutoExport === "boolean") {
      obsidian.autoExport = raw.obsidianAutoExport;
    }
    runtime.setObsidian(obsidian);

    // 只写 provider + contextWindow 两个字段。之前把 readSaved 的返回值摊平到顶层，
    // 导致文件里出现一份重复的扁平副本（密钥也跟着多存了一份），已修正。
    const next: PersistedSettings = {
      provider: nextProvider,
      ...(window !== undefined ? { contextWindow: runtime.currentContextWindow() } : {}),
      reasoning: runtime.reasoningSettings(),
      ...(thinkingFormat ? { thinkingFormat } : {}),
      obsidian: runtime.obsidianSettings(),
    };
    runtime.workspace.writeJSON(join(runtime.workspace.root, SETTINGS_FILE), next);
    // thinking 形态变了要重建 provider 才会生效
    if (thinkingFormat) await runtime.reconfigureProvider(nextProvider, thinkingFormat);

    return c.json({ ok: true });
  });

  /** 手动导出到 Obsidian，返回写了哪些、跳过了哪些。 */
  api.post("/obsidian/export", (c) => {
    const result = runtime.exportToObsidian();
    if (!result.ok) return c.json(result, 400);
    return c.json(result);
  });

  /**
   * 测试连接：用给定（或当前）配置发一条最小请求，看会不会被 401/404/400 拒绝。
   * 不保存、不改变运行时。mock 模式不真正调网络，直接返回 ok。
   */
  api.post("/probe", async (c) => {
    const body = await c.req.json().catch(() => null);
    const raw = (body ?? {}) as Record<string, unknown>;

    let result;
    if (raw.kind === undefined) {
      // 未提供配置：用当前生效配置（可能 mock）
      const current = runtime.currentProviderConfig;
      result = current.kind === "mock"
        ? { ok: true, message: "演示模式，无需连接。" }
        : await probeProvider(current);
    } else {
      const settings = extractSendableSettings(raw);
      if (!settings) return c.json({ error: "provider 配置无效" }, 400);
      // key 未显式给时借用现有 key 试一次
      if (!settings.apiKey) settings.apiKey = runtime.currentApiKey();
      const merged = runtime.mergeForProbe(settings);
      result = merged.kind === "mock"
        ? { ok: true, message: "演示模式，无需连接。" }
        : await probeProvider(merged);
    }

    return c.json(result);
  });

  return api;
}

/** 从请求体抽出发送用的 provider 配置。没给 kind 就返回 null（调用方决定默认）。 */
function extractSendableSettings(raw: Record<string, unknown>): PersistedProviderSettings | null {
  if (raw.kind === undefined) return { kind: "mock" }; // placeholder
  if (!isProviderKind(raw.kind)) return null;

  const settings: PersistedProviderSettings = { kind: raw.kind };
  if (typeof raw.model === "string") settings.model = raw.model.trim();
  if (typeof raw.baseUrl === "string") settings.baseUrl = raw.baseUrl.trim() || undefined;
  if (typeof raw.apiKey === "string") settings.apiKey = raw.apiKey;
  return settings;
}

function readStored(runtime: LearningRuntime): PersistedSettings {
  const stored = runtime.workspace.readJSON<PersistedSettings>(
    join(runtime.workspace.root, SETTINGS_FILE),
  );
  // 文件可能不存在或只有 provider 字段；统一补成完整结构，调用方不用判空
  return { provider: { kind: "mock" }, ...(stored ?? {}) };
}
