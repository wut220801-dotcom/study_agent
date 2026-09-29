/**
 * 一次对话轮次的通用组件：加载会话条目、流式接收回复、发送消息。
 *
 * 规划师和导师的交互形态是一样的（都是「发一条、流式回一段」），差别只在
 * renderEntry——导师那边要把题目、报告、注入渲染成专门的卡片，规划师那边没有这些。
 * 所以把流式那套逻辑收在这里，用 renderEntry 做定制点，避免两份几乎相同的代码。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchSession,
  messageText,
  streamTurn,
  type Entry,
  type TurnHandlers,
  type TurnSummary,
} from "../api.js";
import { Markdown } from "./Markdown.js";

export interface ChatProps {
  sessionId: string;
  /** 发送消息的接口路径 */
  turnPath: string;
  /** 开场接口路径。提供时，空会话会显示「开始」按钮。 */
  kickoffPath?: string;
  emptyHint: React.ReactNode;
  placeholder?: string;
  /** 自定义条目的渲染。返回 null 表示不渲染。 */
  renderEntry?: (entry: Entry) => React.ReactNode | null;
  /** 一轮结束后回调，用于刷新全局状态 */
  onTurnComplete?: () => void;
}

interface ToolActivity {
  name: string;
  status: "running" | "done" | "error";
  content: string;
}

const TOOL_LABELS: Record<string, string> = {
  save_note: "记笔记",
  read_notes: "读笔记",
  ask_learner: "出题",
  report_progress: "上报进度",
  add_knowledge_point: "新增知识点",
  update_knowledge_point: "修改知识点",
  dispatch_tutor: "派发导师",
  read_reports: "查历史报告",
  update_learner_profile: "更新学习者画像",
};

export function Chat({
  sessionId,
  turnPath,
  kickoffPath,
  emptyHint,
  placeholder = "说点什么…（Enter 发送，Shift+Enter 换行）",
  renderEntry,
  onTurnComplete,
}: ChatProps) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamText, setStreamText] = useState("");
  const [tools, setTools] = useState<ToolActivity[]>([]);
  const [lastTurn, setLastTurn] = useState<TurnSummary | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const reload = useCallback(async () => {
    try {
      const { entries } = await fetchSession(sessionId);
      setEntries(entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    setLoading(true);
    setEntries([]);
    setStreamText("");
    setTools([]);
    setError(null);
    void reload();
  }, [reload]);

  // 新内容进来自动滚到底
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, streamText, tools]);

  // 切换会话时中断未完成的请求，避免把上一个会话的输出写进新会话
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, [sessionId]);

  const run = useCallback(
    async (path: string, body: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      setStreamText("");
      setTools([]);

      const controller = new AbortController();
      abortRef.current = controller;

      const handlers: TurnHandlers = {
        onText: (text) => setStreamText((prev) => prev + text),
        onToolStart: (name) =>
          setTools((prev) => [...prev, { name, status: "running", content: "" }]),
        onToolEnd: (name, isError, content) =>
          setTools((prev) => {
            // 从后往前找最近一个同名且还在跑的工具
            for (let i = prev.length - 1; i >= 0; i--) {
              const item = prev[i]!;
              if (item.name === name && item.status === "running") {
                const next = [...prev];
                next[i] = { name, status: isError ? "error" : "done", content };
                return next;
              }
            }
            return prev;
          }),
        onResult: (result) => setLastTurn(result),
        onError: (message) => setError(message),
      };

      try {
        await streamTurn(path, body, handlers, controller.signal);
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        abortRef.current = null;
        setBusy(false);
        setStreamText("");
        setTools([]);
        await reload();
        onTurnComplete?.();
      }
    },
    [reload, onTurnComplete],
  );

  const send = () => {
    const message = input.trim();
    if (!message || busy) return;
    setInput("");
    void run(turnPath, { message });
  };

  const kickoff = () => {
    if (!kickoffPath || busy) return;
    void run(kickoffPath, {});
  };

  // 只渲染有文本的用户消息——工具结果也是 user 角色，但那是内部数据不是人说的话
  const visibleEntries = entries.filter(
    (entry) =>
      entry.type !== "message" ||
      entry.message.role !== "user" ||
      entry.message.content.some((b) => b.type === "text"),
  );

  /**
   * 判断「还没开始对话」看的是有没有真正说过话，而不是条目数。
   * 前置知识注入、题目登记这类自定义条目也会进 entries，但它们不代表对话已经发生——
   * 如果拿条目数判断，一次注入就会把开场按钮顶掉，学习者反而没了入口。
   */
  const hasConversation = entries.some(
    (entry) =>
      entry.type === "message" && entry.message.content.some((b) => b.type === "text"),
  );
  const showKickoff = !hasConversation && !loading && !busy && kickoffPath;

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-3xl space-y-5">
          {loading && <p className="text-sm text-slate-400">载入中…</p>}

          {showKickoff && (
            <div className="rounded-lg border border-dashed border-slate-300 p-6 text-center dark:border-slate-600">
              <div className="mb-3 text-sm text-slate-500 dark:text-slate-400">{emptyHint}</div>
              <button
                onClick={kickoff}
                className="rounded-md bg-slate-800 px-4 py-2 text-sm text-white hover:bg-slate-700 dark:bg-slate-200 dark:text-slate-900 dark:hover:bg-white"
              >
                让导师开场
              </button>
            </div>
          )}
          {visibleEntries.map((entry) => {
            const custom = renderEntry?.(entry);
            if (custom !== undefined && custom !== null) {
              return <div key={entry.id}>{custom}</div>;
            }
            if (entry.type !== "message") return null;

            const text = messageText(entry.message);
            const isUser = entry.message.role === "user";
            // 工具调用作为小标签展示，让「导师做了什么」对学习者可见
            const toolCalls = entry.message.content.filter((b) => b.type === "tool_call");

            return (
              <div key={entry.id} className={isUser ? "flex justify-end" : ""}>
                <div className={isUser ? "max-w-[85%]" : "w-full"}>
                  <div
                    className={
                      isUser
                        ? "rounded-2xl rounded-br-sm bg-slate-800 px-4 py-2.5 text-sm text-white dark:bg-slate-200 dark:text-slate-900"
                        : "text-slate-800 dark:text-slate-100"
                    }
                  >
                    {isUser ? <p className="whitespace-pre-wrap">{text}</p> : <Markdown>{text}</Markdown>}
                  </div>
                  {toolCalls.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {toolCalls.map((call) => (
                        <span
                          key={call.id}
                          className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                        >
                          {TOOL_LABELS[call.name ?? ""] ?? call.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* 正在流的回复 */}
          {busy && (
            <div className="w-full">
              {tools.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {tools.map((tool, index) => (
                    <span
                      key={`${tool.name}-${index}`}
                      className={`rounded px-1.5 py-0.5 text-[11px] ${
                        tool.status === "running"
                          ? "animate-pulse bg-blue-100 text-blue-600 dark:bg-blue-950 dark:text-blue-300"
                          : tool.status === "error"
                            ? "bg-rose-100 text-rose-600 dark:bg-rose-950 dark:text-rose-300"
                            : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                      }`}
                      title={tool.content.slice(0, 300)}
                    >
                      {TOOL_LABELS[tool.name] ?? tool.name}
                      {tool.status === "running" ? "…" : ""}
                    </span>
                  ))}
                </div>
              )}
              {streamText ? (
                <div className="text-slate-800 dark:text-slate-100">
                  <Markdown>{streamText}</Markdown>
                </div>
              ) : (
                tools.length === 0 && <p className="text-sm text-slate-400">思考中…</p>
              )}
            </div>
          )}

          {error && (
            <div className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200">
              {error}
            </div>
          )}
        </div>
      </div>

      {/* 上一轮的用量。缓存命中率放在这里是因为它最能暴露问题：命中率长期为 0
          说明 prompt 前缀被什么东西破坏了，那通常不会以报错的形式表现出来。 */}
      {lastTurn && !busy && (
        <div className="px-6 pb-1">
          <div className="mx-auto flex max-w-3xl flex-wrap gap-x-3 text-[10px] text-slate-400">
            <span>{lastTurn.iterations} 轮工具调用</span>
            <span>输入 {lastTurn.usage.input.toLocaleString()}</span>
            <span>输出 {lastTurn.usage.output.toLocaleString()}</span>
            {lastTurn.usage.cacheRead ? (
              <span>
                缓存命中{" "}
                {Math.round(
                  (lastTurn.usage.cacheRead /
                    (lastTurn.usage.input + lastTurn.usage.cacheRead)) *
                    100,
                )}
                %
              </span>
            ) : null}
            {lastTurn.stopReason === "length" && (
              <span className="text-amber-500">本轮被长度限制截断</span>
            )}
          </div>
        </div>
      )}

      <div className="border-t border-slate-200 px-6 py-3 dark:border-slate-700">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder={placeholder}
            disabled={busy}
            className="max-h-40 min-h-[2.5rem] flex-1 resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-500 disabled:opacity-50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
          />
          <button
            onClick={send}
            disabled={busy || !input.trim()}
            className="h-10 rounded-lg bg-slate-800 px-4 text-sm text-white hover:bg-slate-700 disabled:opacity-40 dark:bg-slate-200 dark:text-slate-900 dark:hover:bg-white"
          >
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
