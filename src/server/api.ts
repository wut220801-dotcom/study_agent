/**
 * HTTP API。
 *
 * 上层只需要知道这几个动作，不需要知道会话树、压缩、缓存这些内部结构。
 * 所有流式的接口都走 SSE（见 sse.ts），其余是普通 JSON。
 */

import { Hono } from "hono";
import { addNode, updateNode } from "../learn/curriculum.js";
import { PLANNER_SESSION_ID, tutorSessionId, type Method, type NodeStatus } from "../learn/types.js";
import type { LearningRuntime } from "../learn/runtime.js";
import { turnStream } from "./sse.js";

export function createApi(runtime: LearningRuntime): Hono {
  const api = new Hono();

  // --- 状态总览 -----------------------------------------------------------

  api.get("/state", (c) => c.json(runtime.snapshot()));

  api.get("/injections", (c) => c.json(runtime.snapshot().injections));

  api.get("/notes/:nodeId", (c) => {
    const nodeId = c.req.param("nodeId");
    return c.json({ nodeId, notes: runtime.notes(nodeId) });
  });

  /**
   * 会话分支。返回原始条目而不是渲染后的消息——界面对报告、题目、注入的呈现方式
   * 和模型看到的完全不同（题目的参考答案要等学习者作答后才显示），这个区分必须在
   * 条目层面保留。
   */
  api.get("/session/:sessionId", (c) => {
    const sessionId = c.req.param("sessionId");
    return c.json({ sessionId, entries: runtime.sessionEntries(sessionId) });
  });

  // --- 对话轮次（流式）----------------------------------------------------

  api.post("/planner/turn", async (c) => {
    const body = await c.req.json<{ message?: string }>();
    const message = (body.message ?? "").trim();
    if (!message) return c.json({ error: "message 不能为空" }, 400);

    return turnStream(c, (emit) => runtime.runPlannerTurn(message, { emit }));
  });

  api.post("/tutor/:nodeId/turn", async (c) => {
    const nodeId = c.req.param("nodeId");
    const body = await c.req.json<{ message?: string }>();
    const message = (body.message ?? "").trim();
    if (!message) return c.json({ error: "message 不能为空" }, 400);

    return turnStream(c, (emit) => runtime.runTutorTurn(nodeId, message, { emit }));
  });

  /** 让导师开场。用于派发之后学习者还没说话时。 */
  api.post("/tutor/:nodeId/kickoff", (c) => {
    const nodeId = c.req.param("nodeId");
    return turnStream(c, (emit) => runtime.kickoffTutor(nodeId, undefined, { emit }));
  });

  // --- 大纲节点 -----------------------------------------------------------

  api.post("/nodes", async (c) => {
    const body = await c.req.json<{
      title?: string;
      objectives?: string[];
      prerequisites?: string[];
      methods?: Method[];
    }>();

    const title = (body.title ?? "").trim();
    if (!title) return c.json({ error: "标题不能为空" }, 400);

    const objectives = (body.objectives ?? []).map((o) => String(o).trim()).filter(Boolean);
    if (objectives.length === 0) {
      return c.json({ error: "至少写一条学习目标，否则导师无法判断教到什么程度算完" }, 400);
    }

    const node = addNode(runtime.getCurriculum(), {
      title,
      objectives,
      prerequisites: body.prerequisites ?? [],
      ...(body.methods?.length ? { methods: body.methods } : {}),
      origin: "user",
    });
    runtime.saveCurriculum();

    return c.json({ node });
  });

  api.patch("/nodes/:nodeId", async (c) => {
    const nodeId = c.req.param("nodeId");
    const body = await c.req.json<Record<string, unknown>>();

    const patch: Parameters<typeof updateNode>[2] = {};
    if (typeof body.title === "string") patch.title = body.title;
    if (Array.isArray(body.objectives)) {
      patch.objectives = body.objectives.map((o) => String(o).trim()).filter(Boolean);
    }
    if (Array.isArray(body.prerequisites)) {
      patch.prerequisites = body.prerequisites.map((p) => String(p));
    }
    if (Array.isArray(body.methods)) patch.methods = body.methods as Method[];
    if (typeof body.status === "string" && isStatus(body.status)) patch.status = body.status;

    const node = updateNode(runtime.getCurriculum(), nodeId, patch);
    if (!node) return c.json({ error: `找不到知识点 ${nodeId}` }, 404);

    runtime.saveCurriculum();
    return c.json({ node });
  });

  // --- 注入 ---------------------------------------------------------------

  api.post("/inject", async (c) => {
    const body = await c.req.json<{ sourceId?: string; targetId?: string; hint?: string }>();
    const sourceId = (body.sourceId ?? "").trim();
    const targetId = (body.targetId ?? "").trim();
    if (!sourceId || !targetId) {
      return c.json({ error: "sourceId 和 targetId 都是必需的" }, 400);
    }

    try {
      const { record, cached, alreadyApplied } = await runtime.inject(
        sourceId,
        targetId,
        body.hint?.trim() || undefined,
      );
      return c.json({ record, cached, alreadyApplied });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
  });

  api.post("/injections/:id/revoke", (c) => {
    try {
      runtime.revokeInjection(c.req.param("id"));
      return c.json({ ok: true });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
  });

  return api;
}

/** 会话 id 由节点 id 派生，这里给前端一个稳定的换算入口。 */
export function sessionIdForNode(nodeId: string): string {
  return tutorSessionId(nodeId);
}

export { PLANNER_SESSION_ID };

function isStatus(value: string): value is NodeStatus {
  return ["pending", "learning", "mastered", "review"].includes(value);
}
