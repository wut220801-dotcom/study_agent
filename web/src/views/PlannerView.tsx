/**
 * 规划师对话视图。
 *
 * 顺带把「规划师看得到什么」明示出来——它只能看到大纲和报告。学习者容易以为
 * 规划师什么都知道，从而奇怪「为什么它不记得我上次卡在哪」。把这个边界写在界面上，
 * 比藏在代码注释里有意义得多。
 */

import { PLANNER_SESSION_ID, type NodeView, type Snapshot } from "../api.js";
import { Chat } from "../components/Chat.js";

export function PlannerView({
  snapshot,
  onChanged,
}: {
  snapshot: Snapshot;
  onChanged: () => void;
}) {
  const mastered = snapshot.nodes.filter((n) => n.status === "mastered").length;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-slate-200 px-6 py-3 dark:border-slate-700">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              学习规划师
            </h2>
            <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
              {snapshot.topic}
              {snapshot.nodes.length > 0 && (
                <>
                  {" · "}
                  {snapshot.nodes.length} 个知识点，{mastered} 个已掌握
                </>
              )}
            </p>
          </div>
          <p className="max-w-md text-right text-[11px] leading-relaxed text-slate-400">
            它只看得到大纲和导师的进度报告，看不到任何教学细节——这是刻意的。
          </p>
        </div>
      </header>

      <div className="min-h-0 flex-1">
        <Chat
          sessionId={PLANNER_SESSION_ID}
          turnPath="/planner/turn"
          emptyHint="告诉它你想学什么。说清楚目的和现在的水平，它才能把大纲拆对——比如「能读懂公司代码库里的 Rust 服务」和「想学 Rust」需要的大纲完全不同。"
          placeholder="想学什么？为什么想学？现在什么水平？（Enter 发送）"
          onTurnComplete={onChanged}
        />
      </div>
    </div>
  );
}
