/**
 * 后端 API 客户端，含 SSE 流式解析。
 *
 * 流式不能用 EventSource——它只支持 GET，而这里是 POST 带 body 的请求。
 * 所以用 fetch 读响应体，手写 SSE 分帧（和服务端同一套逻辑）。
 */

export type Method = "explain" | "practice" | "discuss" | "review";
export type NodeStatus = "pending" | "learning" | "mastered" | "review";

export const METHOD_LABELS: Record<Method, string> = {
  explain: "讲解",
  practice: "练习",
  discuss: "讨论",
  review: "复盘",
};

export const STATUS_LABELS: Record<NodeStatus, string> = {
  pending: "未开始",
  learning: "学习中",
  mastered: "已掌握",
  review: "待复习",
};

export const STATUS_STYLES: Record<NodeStatus, string> = {
  pending: "bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300",
  learning: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200",
  mastered: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-200",
  review: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-200",
};

export interface Report {
  nodeId: string;
  nodeTitle: string;
  status: NodeStatus;
  summary: string;
  suggestedNext?: { title: string; reason: string }[];
  ts: number;
}

export interface KnowledgePoint {
  id: string;
  title: string;
  objectives: string[];
  prerequisites: string[];
  methods: Method[];
  status: NodeStatus;
  notePath: string;
  origin: "user" | "planner" | "tutor-suggestion";
  createdAt: number;
  reportDigest?: string;
}

export interface NodeView extends KnowledgePoint {
  hasNotes: boolean;
  latestReport?: Report;
}

export interface InjectionRecord {
  id: string;
  sourceNodeId: string;
  sourceNodeTitle: string;
  targetNodeId: string;
  targetNodeTitle: string;
  hint?: string;
  content: string;
  entryId: string;
  previousLeafId: string | null;
  ts: number;
  revokedAt?: number;
}

export interface Snapshot {
  topic: string;
  learnerProfile: string;
  nodes: NodeView[];
  injections: InjectionRecord[];
}

// --- 会话条目 ---------------------------------------------------------------

export interface ContentBlock {
  type: "text" | "thinking" | "tool_call" | "tool_result";
  text?: string;
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
  toolCallId?: string;
  content?: string;
  isError?: boolean;
}

export interface AgentMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
  timestamp: number;
}

interface EntryBase {
  id: string;
  parentId: string | null;
  ts: number;
}

export type Entry =
  | (EntryBase & { type: "message"; message: AgentMessage })
  | (EntryBase & {
      type: "compaction";
      summary: string;
      retainedTail: AgentMessage[];
      tokensBefore: number;
    })
  | (EntryBase & {
      type: "custom";
      customType: string;
      data: Record<string, unknown>;
      inContext: boolean;
    });

export const PLANNER_SESSION_ID = "planner";
export const tutorSessionId = (nodeId: string): string => `tutor-${nodeId}`;

// --- 基础请求 ---------------------------------------------------------------

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? `请求失败：HTTP ${response.status}`);
  }

  return (await response.json()) as T;
}

export const fetchState = (): Promise<Snapshot> => request("/state");

export const fetchSession = (sessionId: string): Promise<{ entries: Entry[] }> =>
  request(`/session/${encodeURIComponent(sessionId)}`);

export const fetchNotes = (nodeId: string): Promise<{ notes: string }> =>
  request(`/notes/${encodeURIComponent(nodeId)}`);

export const createNode = (input: {
  title: string;
  objectives: string[];
  prerequisites?: string[];
  methods?: Method[];
}): Promise<{ node: KnowledgePoint }> =>
  request("/nodes", { method: "POST", body: JSON.stringify(input) });

export const patchNode = (
  nodeId: string,
  patch: Partial<Pick<KnowledgePoint, "title" | "objectives" | "prerequisites" | "methods" | "status">>,
): Promise<{ node: KnowledgePoint }> =>
  request(`/nodes/${encodeURIComponent(nodeId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });

export const injectKnowledge = (input: {
  sourceId: string;
  targetId: string;
  hint?: string;
}): Promise<{ record: InjectionRecord; cached: boolean; alreadyApplied: boolean }> =>
  request("/inject", { method: "POST", body: JSON.stringify(input) });

export const revokeInjection = (id: string): Promise<{ ok: true }> =>
  request(`/injections/${encodeURIComponent(id)}/revoke`, { method: "POST" });

// --- 模型设置 ---------------------------------------------------------------

export type ProviderKind = "anthropic" | "openai" | "mock";

export type ReasoningEffort = "off" | "low" | "high" | "max";

export interface SettingsView {
  kind: ProviderKind;
  model: string;
  baseUrl?: string;
  hasApiKey: boolean;
  maskedKey?: string;
  contextWindow: number;
  reasoning: { planner: ReasoningEffort; tutor: ReasoningEffort };
  thinkingFormat: "auto" | "deepseek" | "openai" | "none";
  obsidian: { vaultPath?: string; folder?: string; autoExport?: boolean };
  lastExport: ExportResult | null;
}

export interface ExportResult {
  ok: boolean;
  written: string[];
  skipped: { path: string; reason: string }[];
  error?: string;
  exportedAt: number;
}

export interface SettingsInput {
  kind: ProviderKind;
  model?: string;
  /** 留空表示不修改已保存的 key */
  apiKey?: string;
  baseUrl?: string;
  contextWindow?: number;
  reasoningPlanner?: ReasoningEffort;
  reasoningTutor?: ReasoningEffort;
  thinkingFormat?: SettingsView["thinkingFormat"];
  obsidianVaultPath?: string;
  obsidianFolder?: string;
  obsidianAutoExport?: boolean;
}

export const exportToObsidian = (): Promise<ExportResult> =>
  request("/settings/obsidian/export", { method: "POST", body: "{}" });

export const fetchSettings = (): Promise<SettingsView> => request("/settings");

export const updateSettings = (input: SettingsInput): Promise<{ ok: true }> =>
  request("/settings", { method: "PUT", body: JSON.stringify(input) });

export const probeSettings = (
  input: SettingsInput,
): Promise<{ ok: boolean; message: string }> =>
  request("/settings/probe", { method: "POST", body: JSON.stringify(input) });

// --- 流式对话 ---------------------------------------------------------------

export interface TurnSummary {
  stopReason: string;
  iterations: number;
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  error?: string;
  cached?: boolean;
}

export interface TurnHandlers {
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolStart?: (name: string, args: Record<string, unknown>) => void;
  onToolEnd?: (name: string, isError: boolean, content: string) => void;
  /** 一轮结束。stopReason 不是 stop 时通常意味着被轮次上限或长度截断，值得提示用户。 */
  onResult?: (result: TurnSummary) => void;
  onError?: (message: string) => void;
}

interface SSEFrame {
  event: string;
  data: string;
}

async function* parseSSE(response: Response): AsyncGenerator<SSEFrame> {
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const frame = parseFrame(raw);
      if (frame) yield frame;
      boundary = buffer.indexOf("\n\n");
    }
  }

  const tail = parseFrame(buffer);
  if (tail) yield tail;
}

function parseFrame(raw: string): SSEFrame | null {
  let event = "message";
  const dataLines: string[] = [];

  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

export async function streamTurn(
  path: string,
  body: Record<string, unknown>,
  handlers: TurnHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    handlers.onError?.(errorBody?.error ?? `请求失败：HTTP ${response.status}`);
    return;
  }

  for await (const frame of parseSSE(response)) {
    let payload: any;
    try {
      payload = JSON.parse(frame.data);
    } catch {
      continue;
    }

    switch (frame.event) {
      case "text_delta":
        handlers.onText?.(payload.text);
        break;
      case "thinking_delta":
        handlers.onThinking?.(payload.text);
        break;
      case "tool_start":
        handlers.onToolStart?.(payload.name, payload.args ?? {});
        break;
      case "tool_end":
        handlers.onToolEnd?.(payload.name, Boolean(payload.isError), payload.content ?? "");
        break;
      case "result":
        handlers.onResult?.(payload as TurnSummary);
        // 循环层报出的错误和流错误一样需要让用户看见，否则被截断的一轮会显得像是正常结束
        if (payload.error) handlers.onError?.(payload.error);
        break;
      case "error":
        handlers.onError?.(payload.message);
        break;
    }
  }
}

// --- 展示辅助 ---------------------------------------------------------------

export function messageText(message: AgentMessage): string {
  return message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
