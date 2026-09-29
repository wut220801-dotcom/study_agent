/**
 * 大纲侧栏：知识点列表 + 状态 + 新增表单。
 *
 * 每个节点显示依赖关系和学习方法——这两个信息对学习者判断「现在该学什么」很关键，
 * 不应该藏在详情页里。
 */

import { useState } from "react";
import {
  METHOD_LABELS,
  STATUS_LABELS,
  STATUS_STYLES,
  createNode,
  type Method,
  type NodeView,
} from "../api.js";

const ALL_METHODS: Method[] = ["explain", "practice", "discuss", "review"];

export function CurriculumSidebar({
  nodes,
  selectedNodeId,
  onSelect,
  onChanged,
}: {
  nodes: NodeView[];
  selectedNodeId: string | null;
  onSelect: (nodeId: string) => void;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [objectives, setObjectives] = useState("");
  const [prereqs, setPrereqs] = useState<string[]>([]);
  const [methods, setMethods] = useState<Method[]>(["explain"]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setTitle("");
    setObjectives("");
    setPrereqs([]);
    setMethods(["explain"]);
    setError(null);
    setAdding(false);
  };

  const submit = async () => {
    const lines = objectives
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    if (!title.trim()) return setError("标题不能为空");
    if (lines.length === 0) {
      return setError("至少写一条学习目标。写「能解释…」「能判断…」这类可以被检验的行为。");
    }

    setSaving(true);
    try {
      await createNode({
        title: title.trim(),
        objectives: lines,
        prerequisites: prereqs,
        methods,
      });
      reset();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-700">
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">学习大纲</h2>
        <button
          onClick={() => (adding ? reset() : setAdding(true))}
          className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
        >
          {adding ? "取消" : "+ 添加"}
        </button>
      </div>

      {adding && (
        <div className="space-y-2 border-b border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-700 dark:bg-slate-900">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="知识点标题"
            className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-slate-500 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100"
          />
          <textarea
            value={objectives}
            onChange={(e) => setObjectives(e.target.value)}
            rows={3}
            placeholder={"学习目标，每行一条\n能解释…\n能判断…"}
            className="w-full resize-y rounded border border-slate-300 bg-white px-2 py-1.5 text-xs outline-none focus:border-slate-500 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100"
          />

          <div>
            <p className="mb-1 text-[11px] text-slate-500 dark:text-slate-400">依赖（可选）</p>
            <div className="flex flex-wrap gap-1">
              {nodes
                .filter((n) => n.title !== title)
                .map((node) => {
                  const active = prereqs.includes(node.id);
                  return (
                    <button
                      key={node.id}
                      onClick={() =>
                        setPrereqs((prev) =>
                          active ? prev.filter((p) => p !== node.id) : [...prev, node.id],
                        )
                      }
                      className={`rounded px-1.5 py-0.5 text-[11px] ${
                        active
                          ? "bg-slate-700 text-white dark:bg-slate-200 dark:text-slate-900"
                          : "bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                      }`}
                    >
                      {node.id} {node.title}
                    </button>
                  );
                })}
              {nodes.length === 0 && (
                <span className="text-[11px] text-slate-400">还没有其他知识点</span>
              )}
            </div>
          </div>

          <div>
            <p className="mb-1 text-[11px] text-slate-500 dark:text-slate-400">学习方法</p>
            <div className="flex flex-wrap gap-1">
              {ALL_METHODS.map((method) => {
                const active = methods.includes(method);
                return (
                  <button
                    key={method}
                    onClick={() =>
                      setMethods((prev) =>
                        active ? prev.filter((m) => m !== method) : [...prev, method],
                      )
                    }
                    className={`rounded px-1.5 py-0.5 text-[11px] ${
                      active
                        ? "bg-slate-700 text-white dark:bg-slate-200 dark:text-slate-900"
                        : "bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                    }`}
                  >
                    {METHOD_LABELS[method]}
                  </button>
                );
              })}
            </div>
          </div>

          {error && <p className="text-[11px] text-rose-600 dark:text-rose-400">{error}</p>}

          <button
            onClick={submit}
            disabled={saving}
            className="w-full rounded bg-slate-800 py-1.5 text-xs text-white hover:bg-slate-700 disabled:opacity-40 dark:bg-slate-200 dark:text-slate-900"
          >
            {saving ? "保存中…" : "添加并加入大纲"}
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {nodes.length === 0 && !adding && (
          <p className="px-2 py-4 text-xs text-slate-400">
            大纲还是空的。去「规划师」聊聊你想学什么，他会帮你把知识点拆出来；
            也可以点上面的「+ 添加」自己加一个。
          </p>
        )}

        {nodes.map((node) => {
          const active = node.id === selectedNodeId;
          return (
            <button
              key={node.id}
              onClick={() => onSelect(node.id)}
              className={`mb-1 w-full rounded-md px-3 py-2 text-left transition ${
                active
                  ? "bg-slate-200 dark:bg-slate-700"
                  : "hover:bg-slate-100 dark:hover:bg-slate-800"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-sm text-slate-800 dark:text-slate-100">
                  <span className="mr-1 text-[11px] text-slate-400">{node.id}</span>
                  {node.title}
                </span>
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${STATUS_STYLES[node.status]}`}
                >
                  {STATUS_LABELS[node.status]}
                </span>
              </div>

              <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-slate-400">
                {node.methods.map((m) => (
                  <span key={m}>{METHOD_LABELS[m]}</span>
                ))}
                {node.prerequisites.length > 0 && (
                  <span>依赖 {node.prerequisites.join("、")}</span>
                )}
                {node.hasNotes && <span className="text-emerald-500">有笔记</span>}
                {node.latestReport && <span className="text-blue-500">有报告</span>}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
