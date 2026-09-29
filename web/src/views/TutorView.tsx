/**
 * 导师对话视图：主区域是对话，右侧是实时笔记。
 *
 * 笔记放在旁边常驻是有意的——学习者能随时看到导师正在为他积累什么，
 * 而不是要另外去某个地方找。这也是「学习细节停在这里」这条设计在界面上的体现：
 * 规划师看不到的东西，学习者自己看得一清二楚。
 */

import { useCallback, useEffect, useState } from "react";
import {
  fetchNotes,
  formatTime,
  tutorSessionId,
  type Entry,
  type NodeView,
} from "../api.js";
import { Chat } from "../components/Chat.js";
import { Markdown } from "../components/Markdown.js";

export function TutorView({
  node,
  onChanged,
  onRequestInject,
}: {
  node: NodeView;
  onChanged: () => void;
  onRequestInject: (nodeId: string) => void;
}) {
  const [notes, setNotes] = useState("");
  const [showNotes, setShowNotes] = useState(true);

  const loadNotes = useCallback(async () => {
    const { notes } = await fetchNotes(node.id);
    setNotes(notes);
  }, [node.id]);

  useEffect(() => {
    void loadNotes();
  }, [loadNotes]);

  const renderEntry = (entry: Entry): React.ReactNode | null => {
    if (entry.type !== "custom") return null;

    switch (entry.customType) {
      case "injected_knowledge":
        return <InjectionCard data={entry.data} ts={entry.ts} />;
      case "question":
        return <QuestionCard data={entry.data} ts={entry.ts} />;
      case "report":
        return <ReportCard data={entry.data} ts={entry.ts} />;
      case "kickoff":
        // 开场指令是系统消息，不需要展示给学习者
        return null;
      default:
        return null;
    }
  };

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-slate-200 px-6 py-3 dark:border-slate-700">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">
                <span className="mr-1.5 text-xs text-slate-400">{node.id}</span>
                {node.title}
              </h2>
              {node.objectives.length > 0 && (
                <ul className="mt-0.5 truncate text-[11px] text-slate-500 dark:text-slate-400">
                  {node.objectives.map((o) => (
                    <li key={o}>· {o}</li>
                  ))}
                </ul>
              )}
            </div>
            <div className="flex shrink-0 gap-1.5">
              <button
                onClick={() => onRequestInject(node.id)}
                disabled={!node.hasNotes}
                title={node.hasNotes ? "把这个知识点的笔记压缩后注入别的知识点" : "导师还没有写笔记"}
                className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                注入到…
              </button>
              <button
                onClick={() => setShowNotes((v) => !v)}
                className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                {showNotes ? "隐藏笔记" : "显示笔记"}
              </button>
            </div>
          </div>
        </header>

        <div className="min-h-0 flex-1">
          <Chat
            sessionId={tutorSessionId(node.id)}
            turnPath={`/tutor/${node.id}/turn`}
            kickoffPath={`/tutor/${node.id}/kickoff`}
            emptyHint={`还没有开始学「${node.title}」。点下面的按钮，导师会先看看有没有历史笔记，然后开场。`}
            renderEntry={renderEntry}
            onTurnComplete={() => {
              void loadNotes();
              onChanged();
            }}
          />
        </div>
      </div>

      {showNotes && (
        <aside className="w-96 shrink-0 overflow-y-auto border-l border-slate-200 px-5 py-4 dark:border-slate-700">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
            学习笔记
          </h3>
          {notes ? (
            <div className="text-sm text-slate-700 dark:text-slate-200">
              <Markdown>{notes}</Markdown>
            </div>
          ) : (
            <p className="text-xs text-slate-400">
              导师还没有写笔记。学到成体系的段落时它会记下来，这些内容会成为你的复习资料。
            </p>
          )}
        </aside>
      )}
    </div>
  );
}

/** 前置知识注入卡片。用显眼的边框标出，因为它改变了导师这一轮的判断依据。 */
function InjectionCard({ data, ts }: { data: Record<string, unknown>; ts: number }) {
  const [open, setOpen] = useState(false);
  const content = String(data.content ?? "");

  return (
    <div className="rounded-lg border border-violet-300 bg-violet-50 px-4 py-3 dark:border-violet-800 dark:bg-violet-950/40">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-violet-700 dark:text-violet-300">
          已注入前置知识 · 来自「{String(data.sourceNodeTitle ?? "")}」
        </span>
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-[11px] text-violet-600 hover:underline dark:text-violet-400"
        >
          {open ? "收起" : "展开"}
        </button>
      </div>
      {data.hint ? (
        <p className="mt-1 text-[11px] text-violet-600 dark:text-violet-400">
          备注：{String(data.hint)}
        </p>
      ) : null}
      {open && (
        <div className="mt-2 border-t border-violet-200 pt-2 text-xs text-violet-900 dark:border-violet-800 dark:text-violet-100">
          <Markdown>{content}</Markdown>
        </div>
      )}
      <p className="mt-1 text-[10px] text-violet-400">{formatTime(ts)}</p>
    </div>
  );
}

/**
 * 题目卡片。参考答案默认折叠——这是「题目的参考答案要等学习者作答后才显示」
 * 这个需求在界面上的实现，也是为什么会话条目要保留原始结构而不是统一渲染成消息。
 */
function QuestionCard({ data, ts }: { data: Record<string, unknown>; ts: number }) {
  const [revealed, setRevealed] = useState(false);
  const expects = data.expects ? String(data.expects) : "";

  return (
    <div className="rounded-lg border border-sky-300 bg-sky-50 px-4 py-3 dark:border-sky-800 dark:bg-sky-950/40">
      <span className="text-xs font-medium text-sky-700 dark:text-sky-300">练习</span>
      <p className="mt-1 text-sm text-sky-900 dark:text-sky-100">
        {String(data.question ?? "")}
      </p>
      {expects && (
        <div className="mt-2">
          <button
            onClick={() => setRevealed((v) => !v)}
            className="text-[11px] text-sky-600 hover:underline dark:text-sky-400"
          >
            {revealed ? "隐藏参考答案" : "对照参考答案"}
          </button>
          {revealed && (
            <p className="mt-1 rounded bg-sky-100 px-2 py-1.5 text-xs text-sky-900 dark:bg-sky-900/60 dark:text-sky-100">
              {expects}
            </p>
          )}
        </div>
      )}
      <p className="mt-1 text-[10px] text-sky-400">{formatTime(ts)}</p>
    </div>
  );
}

/** 上报卡片。让学习者看见「导师向规划师说了什么」——这是隔离机制里唯一向上的通道。 */
function ReportCard({ data, ts }: { data: Record<string, unknown>; ts: number }) {
  const suggestions = Array.isArray(data.suggestedNext)
    ? (data.suggestedNext as { title: string; reason: string }[])
    : [];

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-700 dark:bg-slate-800/50">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
          已向规划师上报 · {String(data.status ?? "")}
        </span>
        <span className="text-[10px] text-slate-400">{formatTime(ts)}</span>
      </div>
      <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
        {String(data.summary ?? "")}
      </p>
      {suggestions.length > 0 && (
        <div className="mt-2 border-t border-slate-200 pt-2 text-[11px] text-slate-500 dark:border-slate-700 dark:text-slate-400">
          <p className="mb-0.5">建议补充：</p>
          {suggestions.map((s) => (
            <p key={s.title}>
              · {s.title} —— {s.reason}
            </p>
          ))}
        </div>
      )}
      <p className="mt-1.5 text-[10px] text-slate-400">
        规划师只能看到这条报告，看不到上面的对话内容。
      </p>
    </div>
  );
}
