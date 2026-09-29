/**
 * 注入面板：把一个知识点的笔记压缩后投给另一个知识点的导师。
 *
 * 这是整个框架里唯一的手动跨 agent 操作，所以步骤要透明：
 * 先看清从哪来、到哪去、要强调什么，生成后能读一遍精华再决定要不要留下。
 * 注入记录可撤销——注错了前置知识会持续误导导师，必须能干净地撤掉。
 */

import { useState } from "react";
import {
  formatTime,
  injectKnowledge,
  revokeInjection,
  type InjectionRecord,
  type NodeView,
} from "../api.js";
import { Markdown } from "../components/Markdown.js";

export function InjectView({
  nodes,
  injections,
  initialSourceId,
  initialTargetId,
  onChanged,
}: {
  nodes: NodeView[];
  injections: InjectionRecord[];
  initialSourceId: string | null;
  initialTargetId: string | null;
  onChanged: () => void;
}) {
  const [sourceId, setSourceId] = useState(initialSourceId ?? "");
  const [targetId, setTargetId] = useState(initialTargetId ?? "");
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    record: InjectionRecord;
    cached: boolean;
    alreadyApplied: boolean;
  } | null>(null);

  const withNotes = nodes.filter((n) => n.hasNotes);
  const source = nodes.find((n) => n.id === sourceId);
  const target = nodes.find((n) => n.id === targetId);

  const run = async () => {
    if (!sourceId || !targetId) return setError("请选择源知识点和目标知识点");
    if (sourceId === targetId) return setError("源和目标不能是同一个");

    setBusy(true);
    setError(null);
    setPreview(null);

    try {
      const result = await injectKnowledge({
        sourceId,
        targetId,
        ...(hint.trim() ? { hint: hint.trim() } : {}),
      });
      setPreview(result);
      setHint("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    try {
      await revokeInjection(id);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <div>
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
            知识点之间的注入
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            把「栈与堆」的笔记压缩成面向「所有权转移」的前置知识，交给它的导师。
            压缩是按目标重新组织的，不是通用摘要——所以同一个源知识点投给不同目标，
            得到的精华也不同。
          </p>
        </div>

        <div className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
            <label className="block">
              <span className="mb-1 block text-xs text-slate-500 dark:text-slate-400">
                源知识点（从这里提取）
              </span>
              <select
                value={sourceId}
                onChange={(e) => setSourceId(e.target.value)}
                className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              >
                <option value="">选择…</option>
                {withNotes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.id} {n.title}
                  </option>
                ))}
              </select>
            </label>

            <span className="mt-4 text-slate-400">→</span>

            <label className="block">
              <span className="mb-1 block text-xs text-slate-500 dark:text-slate-400">
                目标知识点（注入给它）
              </span>
              <select
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
                className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              >
                <option value="">选择…</option>
                {nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.id} {n.title}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {withNotes.length === 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              还没有任何知识点写过笔记。先去一个导师那里学一轮——笔记是注入的原料。
            </p>
          )}

          <label className="block">
            <span className="mb-1 block text-xs text-slate-500 dark:text-slate-400">
              额外说明（可选）
            </span>
            <input
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              placeholder="比如：重点保留内存布局那部分，他之前在这块反复出错"
              className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            />
          </label>

          {target && target.prerequisites.includes(sourceId) && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              提示：大纲里「{target.title}」本来就依赖「{source?.title}」，这次注入正合适。
            </p>
          )}

          {error && (
            <p className="rounded bg-rose-50 px-2 py-1.5 text-xs text-rose-700 dark:bg-rose-950 dark:text-rose-200">
              {error}
            </p>
          )}

          <button
            onClick={run}
            disabled={busy || !sourceId || !targetId}
            className="rounded bg-slate-800 px-4 py-2 text-sm text-white hover:bg-slate-700 disabled:opacity-40 dark:bg-slate-200 dark:text-slate-900 dark:hover:bg-white"
          >
            {busy ? "提取精华中…" : "提取精华并注入"}
          </button>
        </div>

        {preview && (
          <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950/40">
            <p className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
              {preview.alreadyApplied
                ? `「${preview.record.targetNodeTitle}」的导师已经拿到了这份前置知识，没有重复注入`
                : `已注入「${preview.record.targetNodeTitle}」的导师上下文`}
              {preview.cached && !preview.alreadyApplied && "（命中缓存，没有重新调用模型）"}
            </p>
            <p className="mt-1 text-[11px] text-emerald-600 dark:text-emerald-400">
              {preview.alreadyApplied
                ? "内容没变就不必再放一份——重复的上下文只会白占 token 并让导师困惑。"
                : "导师在下一轮对话中就能用到这些内容，而且被明确告知不要再重复讲。"}
            </p>
            <div className="mt-3 border-t border-emerald-200 pt-3 text-sm text-emerald-950 dark:border-emerald-800 dark:text-emerald-50">
              <Markdown>{preview.record.content}</Markdown>
            </div>
          </div>
        )}

        {injections.length > 0 && (
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              注入记录
            </h3>
            <div className="space-y-2">
              {injections.map((record) => (
                <div
                  key={record.id}
                  className={`rounded-lg border px-3 py-2.5 ${
                    record.revokedAt
                      ? "border-slate-200 opacity-60 dark:border-slate-700"
                      : "border-slate-300 dark:border-slate-600"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-slate-600 dark:text-slate-300">
                      {record.sourceNodeTitle} → {record.targetNodeTitle}
                      {record.revokedAt && (
                        <span className="ml-1.5 text-slate-400">（已撤销）</span>
                      )}
                    </span>
                    {!record.revokedAt && (
                      <button
                        onClick={() => revoke(record.id)}
                        className="text-[11px] text-slate-500 hover:text-rose-600 hover:underline dark:text-slate-400"
                      >
                        撤销
                      </button>
                    )}
                  </div>
                  {record.hint && (
                    <p className="mt-0.5 text-[11px] text-slate-400">备注：{record.hint}</p>
                  )}
                  <p className="mt-1 text-[11px] text-slate-400">{formatTime(record.ts)}</p>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-slate-400">
              撤销会把目标导师的会话游标移回注入前的位置。注入之后产生的对话也会一并移出当前分支，
              但内容都还在文件里。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
