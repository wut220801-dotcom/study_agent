/**
 * 应用外壳：左侧大纲常驻，右侧在主视图之间切换。
 *
 * 大纲不放进「页面」而是常驻侧栏，是因为它在这套设计里是导航骨架——学习者始终
 * 需要知道自己在整张图的哪个位置，以及还有哪些没学。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchState, type Snapshot } from "./api.js";
import { CurriculumSidebar } from "./views/CurriculumSidebar.js";
import { InjectView } from "./views/InjectView.js";
import { PlannerView } from "./views/PlannerView.js";
import { SettingsView } from "./views/SettingsView.js";
import { TutorView } from "./views/TutorView.js";

type View = "planner" | "tutor" | "inject" | "settings";

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<View>("planner");
  /**
   * 记住进入设置之前在哪。设置是个「配完就走」的页面，和内容页并列放容易让人
   * 找不到出口——所以它需要一个明确的返回目标，而不是只能靠点别的标签页碰运气。
   */
  const returnViewRef = useRef<View>("planner");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [injectSource, setInjectSource] = useState<string | null>(null);
  const [injectTarget, setInjectTarget] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchState();
      setSnapshot(next);
      setLoadError(null);
      // 选中的节点被删掉或还没选时，回落到第一个
      setSelectedNodeId((current) => {
        if (current && next.nodes.some((n) => n.id === current)) return current;
        return next.nodes[0]?.id ?? null;
      });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openTutor = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    setView("tutor");
  };

  /** 从导师页面点「注入到…」：预填源知识点，跳到注入面板选目标。 */
  const startInjectFrom = (nodeId: string) => {
    returnViewRef.current = "tutor";
    setInjectSource(nodeId);
    const candidates = snapshot?.nodes.filter((n) => n.id !== nodeId) ?? [];
    setInjectTarget(candidates[0]?.id ?? null);
    setView("inject");
  };

  const selectedNode = snapshot?.nodes.find((n) => n.id === selectedNodeId) ?? null;

  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md rounded-lg border border-rose-300 bg-rose-50 p-5 text-sm dark:border-rose-800 dark:bg-rose-950">
          <p className="font-medium text-rose-800 dark:text-rose-200">连不上后端</p>
          <p className="mt-1 text-rose-700 dark:text-rose-300">{loadError}</p>
          <p className="mt-3 text-xs text-rose-600 dark:text-rose-400">
            确认后端进程已启动：在项目根目录运行 <code>npm run dev</code>。
          </p>
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-400">
        载入中…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="flex items-center justify-between border-b border-slate-200 px-5 py-2.5 dark:border-slate-700">
        <div className="flex items-baseline gap-3">
          <h1 className="text-sm font-semibold">学习 Agent</h1>
          <span className="text-[11px] text-slate-400">
            规划师管大纲，导师管教学，两边上下文隔离
          </span>
        </div>

        <nav className="flex items-center gap-1">
          <NavButton active={view === "planner"} onClick={() => setView("planner")}>
            规划师
          </NavButton>
          <NavButton
            active={view === "tutor"}
            onClick={() => selectedNodeId && setView("tutor")}
            disabled={!selectedNodeId}
          >
            导师
          </NavButton>
          <NavButton active={view === "inject"} onClick={() => setView("inject")}>
            注入
            {snapshot.injections.filter((i) => !i.revokedAt).length > 0 && (
              <span className="ml-1.5 rounded bg-violet-100 px-1 text-[10px] text-violet-700 dark:bg-violet-900 dark:text-violet-200">
                {snapshot.injections.filter((i) => !i.revokedAt).length}
              </span>
            )}
          </NavButton>
          <NavButton
            active={view === "settings"}
            onClick={() => {
              if (view !== "settings") returnViewRef.current = view;
              setView("settings");
            }}
          >
            设置
          </NavButton>
        </nav>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-72 shrink-0 border-r border-slate-200 dark:border-slate-700">
          <CurriculumSidebar
            nodes={snapshot.nodes}
            selectedNodeId={selectedNodeId}
            onSelect={(nodeId) => {
              setSelectedNodeId(nodeId);
              setView("tutor");
            }}
            onChanged={refresh}
          />
        </aside>

        <main className="min-w-0 flex-1">
          {view === "planner" && <PlannerView snapshot={snapshot} onChanged={refresh} />}

          {view === "tutor" &&
            (selectedNode ? (
              <TutorView
                key={selectedNode.id}
                node={selectedNode}
                onChanged={refresh}
                onRequestInject={startInjectFrom}
              />
            ) : (
              <EmptyState
                title="还没有选中知识点"
                body="在左边选一个知识点，或者先去规划师那里把你的学习目标讲清楚，让他帮你搭出大纲。"
                action={{ label: "去和规划师聊", onClick: () => setView("planner") }}
              />
            ))}

          {view === "inject" && (
            <InjectView
              nodes={snapshot.nodes}
              injections={snapshot.injections}
              initialSourceId={injectSource}
              initialTargetId={injectTarget}
              onChanged={refresh}
            />
          )}

          {view === "settings" && (
            <SettingsView
              onChanged={refresh}
              onClose={() => setView(returnViewRef.current)}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function NavButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md px-3 py-1.5 text-xs transition disabled:opacity-40 ${
        active
          ? "bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900"
          : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
      }`}
    >
      {children}
    </button>
  );
}

function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md text-center">
        <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{title}</p>
        <p className="mt-1.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">{body}</p>
        <button
          onClick={action.onClick}
          className="mt-4 rounded-md bg-slate-800 px-4 py-2 text-xs text-white hover:bg-slate-700 dark:bg-slate-200 dark:text-slate-900 dark:hover:bg-white"
        >
          {action.label}
        </button>
      </div>
    </div>
  );
}
