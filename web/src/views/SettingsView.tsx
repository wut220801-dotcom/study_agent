/**
 * 设置页：配置模型 provider，保存后立即生效，不需要重启服务。
 *
 * 设计取舍：
 * - key 输入框留空 = 不修改已有 key。这样「只想换个模型名」的操作不必重新粘贴密钥。
 * - 「测试连接」用的是**表单当前值**而不是已保存值，所以可以先试通再保存。
 * - contextWindow 会直接影响上下文压缩的触发阈值，所以它和 provider 放在同一页，
 *   而不是藏在别处——用第三方模型时它是必须改的一项。
 */

import { useCallback, useEffect, useState } from "react";
import {
  exportToObsidian,
  fetchSettings,
  probeSettings,
  updateSettings,
  type ExportResult,
  type ProviderKind,
  type ReasoningEffort,
  type SettingsView,
} from "../api.js";

const EFFORT_OPTIONS: { value: ReasoningEffort; label: string; hint: string }[] = [
  { value: "off", label: "关闭", hint: "不思考，最快最省。适合简单任务。" },
  { value: "low", label: "低", hint: "少量思考。" },
  { value: "high", label: "高（默认）", hint: "服务商调过的甜点位置，通常不必改。" },
  { value: "max", label: "最高", hint: "想得更久，但边际收益小、延迟和费用明显上升。" },
];

const KIND_OPTIONS: { value: ProviderKind; label: string; hint: string }[] = [
  {
    value: "anthropic",
    label: "Anthropic",
    hint: "官方 Claude。默认模型 claude-sonnet-4-5。",
  },
  {
    value: "openai",
    label: "OpenAI 兼容",
    hint: "OpenAI 官方，或任何遵循该协议的第三方服务（DeepSeek / Moonshot / Qwen / vLLM）。第三方要填 baseUrl。",
  },
  {
    value: "mock",
    label: "演示模式",
    hint: "桩数据，不联网、不需要 key。用来先确认界面和流程。",
  },
];

const MODEL_EXAMPLES: Record<string, string> = {
  anthropic: "claude-sonnet-4-5 / claude-haiku-4-5",
  openai: "gpt-4o / deepseek-v4-flash / qwen-plus",
  mock: "",
};

/**
 * 常用服务的快速预设。
 *
 * 参数取自 deepseek-harness 自己的 DeepSeek 适配器配置：官方路线是 chat-completions，
 * V4 系列默认开启 thinking，上下文窗口是 100 万。这些值手填很容易错，尤其是上下文窗口
 * ——填小了会压缩过早，填大了请求直接超限。
 */
interface Preset {
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  contextWindow: number;
  note: string;
}

const PRESETS: Preset[] = [
  {
    label: "DeepSeek（官方）",
    kind: "openai",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    contextWindow: 1_000_000,
    note: "推荐。DeepSeek 原生支持的 chat-completions 协议。",
  },
  {
    label: "DeepSeek（Anthropic 兼容）",
    kind: "anthropic",
    baseUrl: "https://api.deepseek.com/anthropic",
    model: "deepseek-v4-flash",
    contextWindow: 1_000_000,
    note: "走 Anthropic 格式的兼容端点。",
  },
  {
    label: "Anthropic 官方",
    kind: "anthropic",
    baseUrl: "",
    model: "claude-sonnet-4-5",
    contextWindow: 200_000,
    note: "直连 Anthropic。",
  },
];

export function SettingsView({
  onChanged,
  onClose,
}: {
  onChanged: () => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [kind, setKind] = useState<ProviderKind>("mock");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [contextWindow, setContextWindow] = useState(200000);
  const [reasoningPlanner, setReasoningPlanner] = useState<ReasoningEffort>("high");
  const [reasoningTutor, setReasoningTutor] = useState<ReasoningEffort>("high");
  const [vaultPath, setVaultPath] = useState("");
  const [vaultFolder, setVaultFolder] = useState("学习Agent");
  const [autoExport, setAutoExport] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);

  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const next = await fetchSettings();
    setView(next);
    setKind(next.kind);
    // 表单初始值用「当前生效」的模型与地址：启动时已经把保存值合并进生效值，
    // 所以两者一致，不需要区分。
    setModel(next.model);
    setBaseUrl(next.baseUrl ?? "");
    setContextWindow(next.contextWindow);
    setReasoningPlanner(next.reasoning?.planner ?? "high");
    setReasoningTutor(next.reasoning?.tutor ?? "high");
    setVaultPath(next.obsidian?.vaultPath ?? "");
    setVaultFolder(next.obsidian?.folder ?? "学习Agent");
    setAutoExport(Boolean(next.obsidian?.autoExport));
    setExportResult(next.lastExport ?? null);
    setApiKey(""); // 永不回填明文 key
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 一键填入预设。key 不动——预设里没有密钥，用户仍需自己填。 */
  const applyPreset = (preset: Preset) => {
    setKind(preset.kind);
    setModel(preset.model);
    setBaseUrl(preset.baseUrl);
    setContextWindow(preset.contextWindow);
    setMessage(null);
  };

  const exportNow = async () => {
    setExporting(true);
    try {
      // 先保存路径再导出，否则导出用的还是旧路径
      await updateSettings({
        kind,
        model,
        apiKey,
        baseUrl,
        contextWindow,
        reasoningPlanner,
        reasoningTutor,
        obsidianVaultPath: vaultPath,
        obsidianFolder: vaultFolder,
        obsidianAutoExport: autoExport,
      });
      setExportResult(await exportToObsidian());
    } catch (error) {
      setExportResult({
        ok: false,
        written: [],
        skipped: [],
        error: error instanceof Error ? error.message : String(error),
        exportedAt: Date.now(),
      });
    } finally {
      setExporting(false);
    }
  };

  const isMock = kind === "mock";
  const keyPlaceholder = view?.hasApiKey
    ? `已保存（${view.maskedKey}）——留空则不改动`
    : "粘贴 API key";

  /**
   * 切换提供方时清空模型名和 baseUrl。
   *
   * 这两个值是跟着 provider 走的：不清空的话，从演示模式切到 OpenAI 时输入框里会
   * 留着 "mock-demo"，用户直接点保存就把一个无效的模型名提交上去了。
   * 切回当前生效的那个 provider 时恢复原值，避免来回切换丢失已填内容。
   */
  const changeKind = (next: ProviderKind) => {
    setKind(next);
    if (next === view?.kind) {
      setModel(view.model);
      setBaseUrl(view.baseUrl ?? "");
    } else {
      setModel("");
      setBaseUrl("");
    }
    setMessage(null);
  };

  const probe = async () => {
    setProbing(true);
    setMessage(null);
    try {
      const result = await probeSettings({ kind, model, apiKey, baseUrl });
      setMessage({ ok: result.ok, text: result.ok ? `✓ ${result.message}` : `✗ ${result.message}` });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setProbing(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await updateSettings({
        kind,
        model,
        apiKey,
        baseUrl,
        contextWindow,
        reasoningPlanner,
        reasoningTutor,
        obsidianVaultPath: vaultPath,
        obsidianFolder: vaultFolder,
        obsidianAutoExport: autoExport,
      });
      await load();
      onChanged();
      setMessage({
        ok: true,
        text: isMock ? "已保存。当前是演示模式。" : "已保存并立即生效——下一轮对话就会用新模型。",
      });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  };

  if (!view) {
    return <div className="p-8 text-sm text-slate-400">载入中…</div>;
  }

  return (
    <div className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-2xl space-y-6">
        <div>
          <button
            onClick={onClose}
            className="mb-3 text-xs text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100"
          >
            ← 返回
          </button>
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">模型设置</h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            保存后立即生效，不需要重启。配置存在 <code>workspace/settings.json</code>，
            优先级高于 <code>.env</code>，所以重启也仍然有效。
          </p>
        </div>

        {/* 当前生效状态 */}
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs dark:border-slate-700 dark:bg-slate-800/50">
          <span className="text-slate-500 dark:text-slate-400">当前生效：</span>
          <span className="ml-1 font-medium text-slate-700 dark:text-slate-200">
            {view.kind} · {view.model}
          </span>
          {view.baseUrl && <span className="ml-2 text-slate-400">@ {view.baseUrl}</span>}
          {!view.hasApiKey && !isMock && (
            <span className="ml-2 text-amber-600 dark:text-amber-400">（还没有 key）</span>
          )}
        </div>

        {/* 快速预设 */}
        <div className="space-y-2">
          <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">
            快速填充
          </label>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((preset) => (
              <button
                key={preset.label}
                onClick={() => applyPreset(preset)}
                title={preset.note}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                {preset.label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-slate-400">
            填入 baseUrl、模型名和上下文窗口，API key 仍需你自己填。
          </p>
        </div>

        {/* provider 选择 */}
        <div className="space-y-2">
          <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">
            提供方
          </label>
          <div className="space-y-1.5">
            {KIND_OPTIONS.map((option) => (
              <label
                key={option.value}
                className={`flex cursor-pointer gap-3 rounded-lg border px-3 py-2.5 transition ${
                  kind === option.value
                    ? "border-slate-800 bg-slate-50 dark:border-slate-300 dark:bg-slate-800"
                    : "border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800/50"
                }`}
              >
                <input
                  type="radio"
                  name="kind"
                  checked={kind === option.value}
                  onChange={() => changeKind(option.value)}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="block text-sm text-slate-800 dark:text-slate-100">
                    {option.label}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                    {option.hint}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </div>

        {!isMock && (
          <div className="space-y-4 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
            <label className="block">
              <span className="mb-1 block text-xs text-slate-500 dark:text-slate-400">
                API key
              </span>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={keyPlaceholder}
                autoComplete="off"
                className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 font-mono text-sm outline-none focus:border-slate-500 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              />
              <span className="mt-1 block text-[11px] text-slate-400">
                只保存在本机的 workspace/settings.json，不会发送到除模型服务商以外的任何地方。
              </span>
            </label>

            <label className="block">
              <span className="mb-1 block text-xs text-slate-500 dark:text-slate-400">
                模型名
              </span>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={MODEL_EXAMPLES[kind]}
                className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 font-mono text-sm outline-none focus:border-slate-500 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-xs text-slate-500 dark:text-slate-400">
                baseUrl（可选）
              </span>
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={
                  kind === "openai"
                    ? "留空用官方 https://api.openai.com/v1；第三方填其地址"
                    : "留空用官方 https://api.anthropic.com"
                }
                className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 font-mono text-sm outline-none focus:border-slate-500 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              />
            </label>
          </div>
        )}

        <label className="block">
          <span className="mb-1 block text-xs text-slate-500 dark:text-slate-400">
            上下文窗口（tokens）
          </span>
          <input
            type="number"
            value={contextWindow}
            onChange={(e) => setContextWindow(Number(e.target.value))}
            min={8000}
            step={1000}
            className="w-48 rounded border border-slate-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-slate-500 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
          />
          <span className="mt-1 block text-[11px] leading-relaxed text-slate-400">
            用来推导上下文压缩的触发阈值。<strong>用第三方模型时一定要按实际值填</strong>——
            填大了会在请求超限时直接失败，填小了会压缩过早。
          </span>
        </label>

        {/* 推理强度：按角色分开 */}
        <div className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
          <div>
            <span className="block text-xs font-medium text-slate-500 dark:text-slate-400">
              推理强度
            </span>
            <span className="mt-1 block text-[11px] leading-relaxed text-slate-400">
              控制模型回答前花多少 token 在内部思考上。这不是「提升智力」的开关，而是
              <strong>拿延迟和费用换多步推理的准确率</strong>——对拆解大纲这类任务有实际帮助，
              对回答一个定义问题则几乎没有收益。
            </span>
          </div>

          <label className="block">
            <span className="mb-1 block text-xs text-slate-600 dark:text-slate-300">
              规划师（拆大纲、排依赖、判断下一步）
            </span>
            <select
              value={reasoningPlanner}
              onChange={(e) => setReasoningPlanner(e.target.value as ReasoningEffort)}
              className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            >
              {EFFORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label} —— {option.hint}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs text-slate-600 dark:text-slate-300">
              导师（讲解、答疑、出题）
            </span>
            <select
              value={reasoningTutor}
              onChange={(e) => setReasoningTutor(e.target.value as ReasoningEffort)}
              className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            >
              {EFFORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label} —— {option.hint}
                </option>
              ))}
            </select>
          </label>

          <p className="text-[11px] leading-relaxed text-slate-400">
            压缩摘要和「测试连接」始终关闭思考——那是「把给你的材料处理一下」的任务，
            想再久也没有帮助，反而会把输出预算吃光。
          </p>
        </div>

        {/* Obsidian 导出 */}
        <div className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
          <div>
            <span className="block text-xs font-medium text-slate-500 dark:text-slate-400">
              导出到 Obsidian
            </span>
            <span className="mt-1 block text-[11px] leading-relaxed text-slate-400">
              Obsidian 库就是本地的 markdown 文件夹，所以这里直接往里写文件，不需要装任何插件。
              知识点之间的依赖会渲染成双链 —— 导出后打开图谱视图，你的学习路径本身就是一张图。
            </span>
          </div>

          <label className="block">
            <span className="mb-1 block text-xs text-slate-600 dark:text-slate-300">
              库路径（填能看到 .obsidian 的那一层）
            </span>
            <input
              type="text"
              value={vaultPath}
              onChange={(e) => setVaultPath(e.target.value)}
              placeholder="/Users/you/Documents/MyVault"
              className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 font-mono text-sm outline-none focus:border-slate-500 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            />
            <span className="mt-1 block text-[11px] text-slate-400">
              留空表示不导出。保存时会检查这个目录里有没有 .obsidian，填错会直接报错。
            </span>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs text-slate-600 dark:text-slate-300">
              子文件夹
            </span>
            <input
              type="text"
              value={vaultFolder}
              onChange={(e) => setVaultFolder(e.target.value)}
              placeholder="学习Agent"
              className="w-64 rounded border border-slate-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-slate-500 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            />
            <span className="mt-1 block text-[11px] text-slate-400">
              所有生成的文件都收在这里，不会弄乱你库根目录。
            </span>
          </label>

          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={autoExport}
              onChange={(e) => setAutoExport(e.target.checked)}
              className="mt-0.5"
            />
            <span className="text-xs text-slate-600 dark:text-slate-300">
              每轮学习结束后自动导出
              <span className="mt-0.5 block text-[11px] text-slate-400">
                只是本地写几个文件，很快。开着的话 Obsidian 那边始终是最新的。
              </span>
            </span>
          </label>

          <div className="flex items-center gap-2">
            <button
              onClick={exportNow}
              disabled={exporting || !vaultPath.trim()}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              {exporting ? "导出中…" : "立即导出一次"}
            </button>
            <span className="text-[11px] text-slate-400">会先保存上面的路径，再导出</span>
          </div>

          {exportResult && (
            <div
              className={`rounded-md border px-3 py-2 text-xs ${
                exportResult.ok
                  ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                  : "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200"
              }`}
            >
              {exportResult.ok ? (
                <>
                  <p className="font-medium">
                    已写入 {exportResult.written.length} 个文件到「{vaultFolder}」
                  </p>
                  {exportResult.written.length > 0 && (
                    <ul className="mt-1 space-y-0.5 text-[11px] opacity-80">
                      {exportResult.written.slice(0, 6).map((file) => (
                        <li key={file}>{file}</li>
                      ))}
                      {exportResult.written.length > 6 && (
                        <li>…还有 {exportResult.written.length - 6} 个</li>
                      )}
                    </ul>
                  )}
                  {exportResult.skipped.length > 0 && (
                    <div className="mt-2 border-t border-emerald-200 pt-2 dark:border-emerald-800">
                      <p className="font-medium">跳过 {exportResult.skipped.length} 个：</p>
                      <ul className="mt-0.5 space-y-0.5 text-[11px] opacity-80">
                        {exportResult.skipped.map((item) => (
                          <li key={item.path}>
                            {item.path} —— {item.reason}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              ) : (
                <p>{exportResult.error}</p>
              )}
            </div>
          )}
        </div>

        {message && (
          <div
            className={`rounded-md border px-3 py-2 text-sm ${
              message.ok
                ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                : "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200"
            }`}
          >
            {message.text}
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={save}
            disabled={saving || probing}
            className="rounded-md bg-slate-800 px-4 py-2 text-sm text-white hover:bg-slate-700 disabled:opacity-40 dark:bg-slate-200 dark:text-slate-900 dark:hover:bg-white"
          >
            {saving ? "保存中…" : "保存并生效"}
          </button>
          {!isMock && (
            <button
              onClick={probe}
              disabled={saving || probing}
              title="用上面的配置发一条最小请求，验证 key 和模型名是否正确。不会保存。"
              className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              {probing ? "测试中…" : "测试连接"}
            </button>
          )}
        </div>

        <p className="text-[11px] leading-relaxed text-slate-400">
          「测试连接」会真的发一次请求（约 10 个 token 的费用），用来确认 key、模型名、
          baseUrl 三者都对。比聊了一轮才发现配置错了要省事得多。
        </p>
      </div>
    </div>
  );
}
