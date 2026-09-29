/**
 * 装配层：把 provider、会话、工具、压缩、注入拼成一个可用的系统。
 *
 * 这一层存在的意义是让上层（HTTP / CLI）不需要知道任何内部结构：
 * 它只暴露「跑一轮规划师对话」「跑一轮导师对话」「注入」「拿快照」这几个动作。
 */

import { Session } from "../core/session.js";
import { runAgentLoop, type LoopEvent, type LoopResult } from "../core/loop.js";
import {
  compactMessages,
  shouldCompact,
  type CompactionSettings,
} from "../core/compaction.js";
import type { Provider, ProviderConfig } from "../core/provider/types.js";

import { userText, type Message } from "../core/types.js";
import { createProvider } from "../core/provider/index.js";
import type { AppConfig } from "../config.js";

import { createCurriculum } from "./curriculum.js";
import { ENTRY_KICKOFF } from "./entries.js";
import {
  applyInjection,
  generateEssence,
  listInjections,
  revokeInjection,
  validateInjection,
} from "./inject.js";
import { appendCompactionToNotes, hasNotes, readNotes } from "./notes.js";
import { buildPlannerSystemPrompt, createPlannerRegistry, latestReportsByNode, type PlannerToolContext } from "./planner.js";
import { buildTutorSystemPrompt, createTutorRegistry, type TutorToolContext } from "./tutor.js";
import {
  PLANNER_SESSION_ID,
  tutorSessionId,
  type Curriculum,
  type InjectionRecord,
  type KnowledgePoint,
  type NodeStatus,
  type Report,
} from "./types.js";
import { Workspace } from "./workspace.js";
import { renderLearnEntry } from "./entries.js";
import {
  clampContextWindow,
  maskApiKey,
  mergeProviderConfig,
  validatePersistedSettings,
  DEFAULT_REASONING,
  type PersistedProviderSettings,
  type ReasoningSettings,
} from "../settings.js";
import type { ReasoningEffort, ThinkingFormat } from "../core/provider/types.js";
import {
  exportToObsidian as runObsidianExport,
  type ExportResult,
  type ObsidianSettings,
} from "./obsidian.js";
import type { VaultAccess } from "./vault-access.js";
import {
  buildCustomRolePrompt,
  customRoleSessionId,
  type CustomRole,
} from "./roles.js";
import { listVaultStructureTool, readVaultNoteTool } from "./vault-tools.js";
import { ToolRegistry } from "../core/tools/types.js";

/** 自定义角色的工具上下文：只需要能看库，不需要大纲和知识点。 */
export interface CustomRoleToolContext {
  vault?: VaultAccess;
  workFolder?: string;
}

/**
 * 自定义角色的工具表。
 *
 * 刻意**只给读的能力**：这类角色（总结、梳理、换个角度讲）本来就不该去改大纲、
 * 也不该往导师的笔记里写东西。想让它产出内容，它写在回复里就行——用户自己决定
 * 要不要落成笔记。这比给它写权限安全得多，也更容易理解。
 */
function createCustomRoleRegistry(hasVault: boolean): ToolRegistry<CustomRoleToolContext> {
  const registry = new ToolRegistry<CustomRoleToolContext>();
  if (hasVault) {
    registry.register(listVaultStructureTool);
    registry.register(readVaultNoteTool);
  }
  return registry;
}

export interface TurnHooks {
  emit?: (event: LoopEvent) => void;
  signal?: AbortSignal;
}

export interface NodeView extends KnowledgePoint {
  hasNotes: boolean;
  latestReport?: Report;
}

export interface RuntimeSnapshot {
  topic: string;
  learnerProfile: string;
  nodes: NodeView[];
  injections: InjectionRecord[];
}

/** 导师开场时收到的系统指令。作为 kickoff 条目进上下文，不是伪造的用户发言。 */
const KICKOFF_INSTRUCTION = `（系统）这个知识点的学习现在开始。

请先调用 read_notes 看看自己是否已经为这个知识点记过笔记：
- 如果有笔记，说明学习者之前学过一部分，从记录的进度接着往下走，不要从头开始。
- 如果没有，这是第一次。

然后向学习者开场。开场要简短：说明这个知识点解决什么问题、你打算怎么带他学、第一步做什么。
不要长篇介绍，直接进入教学。`;

export class LearningRuntime {
  readonly workspace: Workspace;
  private provider: Provider;
  private providerConfig: ProviderConfig;
  private contextWindow: number;
  private readonly maxIterations: number;
  private readonly maxOutputTokens: number;
  private reasoning: Required<ReasoningSettings> = { ...DEFAULT_REASONING };
  private obsidian: ObsidianSettings = {};
  private lastExport: ExportResult | null = null;
  /**
   * 库访问能力，由宿主注入（插件用 app.vault，服务端不提供）。
   * 它决定 planner / tutor 的工具表里有没有「看笔记库」这类工具。
   */
  private vaultAccess?: VaultAccess;
  private workFolder = "学习Agent";
  private readonly sessions = new Map<string, Session>();
  private curriculum: Curriculum;

  constructor(config: AppConfig, providerOverride?: Provider) {
    this.workspace = new Workspace(config.workspaceRoot);
    // providerOverride 是给测试用的接缝:有了它,测试才能拿到实际发出的请求,
    // 从而验证「注入的内容确实进了导师的上下文」这类性质——靠读代码是查不出来的。
    this.provider = providerOverride ?? createProvider(config.provider);
    this.providerConfig = config.provider;
    this.contextWindow = config.contextWindow;
    this.maxIterations = config.maxIterations;
    this.maxOutputTokens = config.maxOutputTokens;
    this.reasoning = { ...config.reasoning };
    this.obsidian = { ...config.obsidian };

    this.curriculum =
      this.workspace.readJSON<Curriculum>(this.workspace.curriculumPath) ??
      createCurriculum("(尚未设定)", "");
  }

  // -------------------------------------------------------------------------
  // 运行时配置(界面可调)
  // -------------------------------------------------------------------------

  /** 当前生效的 provider 配置。隐藏内容通过打码暴露,不返回明文 key。 */
  effectiveProviderConfig(): {
    kind: string;
    model: string;
    baseUrl?: string;
    hasApiKey: boolean;
    maskedKey?: string;
    enableCaching?: boolean;
  } {
    const cfg = this.providerConfig;
    return {
      kind: cfg.kind,
      model: cfg.model,
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
      hasApiKey: Boolean(cfg.apiKey),
      ...(cfg.apiKey ? { maskedKey: maskApiKey(cfg.apiKey) } : {}),
      ...(cfg.enableCaching !== undefined ? { enableCaching: cfg.enableCaching } : {}),
    };
  }

  currentContextWindow(): number {
    return this.contextWindow;
  }

  /** probe 接口借用当前生效 key 时的入口。 */
  currentApiKey(): string {
    return this.providerConfig.apiKey ?? "";
  }

  currentKind(): string {
    return this.providerConfig.kind;
  }

  currentModel(): string {
    return this.providerConfig.model;
  }

  /** probe 接口在给定（未保存的）配置之上合并当前 key，用于『试连但不保存』。 */
  mergeForProbe(settings: PersistedProviderSettings): ProviderConfig {
    return mergeProviderConfig(this.providerConfig, settings);
  }

  /**
   * 应用新的 provider 配置。替换 provider 实例,不碰会话——已加载的会话树原样保留。
   * 校验放在这里而不是 server 层,让 CLI 入口也自动获得同样的约束。
   */
  async reconfigureProvider(
    settings: PersistedProviderSettings,
    thinkingFormat?: ThinkingFormat,
  ): Promise<{ config: ProviderConfig; ok: boolean; error?: string }> {
    const merged = mergeProviderConfig(this.providerConfig, settings);
    if (thinkingFormat) merged.thinkingFormat = thinkingFormat;
    const validation = validatePersistedSettings(settings, merged);
    if (validation) {
      return { config: merged, ok: false, error: validation };
    }

    this.provider = createProvider(merged);
    this.providerConfig = merged;
    return { config: merged, ok: true };
  }

  /** 从磁盘加载过的持久设置里恢复推理配置（config 在启动时已合并，这里只取推理部分） */
  reasoningSettings(): Required<ReasoningSettings> {
    return { ...this.reasoning };
  }

  /** 注入库访问能力。必须在第一次对话之前调用，因为工具表在每轮开始时构建。 */
  setVaultAccess(access: VaultAccess | undefined, workFolder: string): void {
    this.vaultAccess = access;
    this.workFolder = workFolder;
  }

  obsidianSettings(): ObsidianSettings {
    return { ...this.obsidian };
  }

  setObsidian(next: ObsidianSettings): void {
    this.obsidian = { ...this.obsidian, ...next };
  }

  lastObsidianExport(): ExportResult | null {
    return this.lastExport;
  }

  /** 手动导出。返回结果供界面展示（写了哪些、跳过了哪些）。 */
  exportToObsidian(): ExportResult {
    const result = runObsidianExport({
      workspace: this.workspace,
      curriculum: this.curriculum,
      settings: this.obsidian,
    });
    this.lastExport = result;
    return result;
  }

  /**
   * 一轮结束后按配置自动导出。
   *
   * 导出只是本地写文件，成本极低；但**绝不能让它影响对话**——库路径失效、权限问题
   * 之类都不该把一轮学习变成错误。所以这里吞掉异常，只把结果记在 lastExport 里。
   */
  private maybeAutoExport(): void {
    if (!this.obsidian.autoExport || !this.obsidian.vaultPath) return;
    try {
      this.exportToObsidian();
    } catch (error) {
      this.lastExport = {
        ok: false,
        written: [],
        skipped: [],
        error: error instanceof Error ? error.message : String(error),
        exportedAt: Date.now(),
      };
    }
  }

  /** 当前 thinking 字段的 wire 形态（auto 表示由 provider 按地址推断）。 */
  thinkingFormat(): ThinkingFormat {
    return this.providerConfig.thinkingFormat ?? "auto";
  }

  setReasoning(next: ReasoningSettings): void {
    if (next.planner) this.reasoning.planner = next.planner;
    if (next.tutor) this.reasoning.tutor = next.tutor;
  }

  setContextWindow(contextWindow: number): void {
    this.contextWindow = clampContextWindow(contextWindow, this.contextWindow);
  }

  compactionSettings(): CompactionSettings {
    return {
      contextWindow: this.contextWindow,
      reserveTokens: 16_384,
      keepRecentTokens: 12_000,
    };
  }

  // 测试用:当前生效的 provider 配置,用于 probe 复用当前 key 的场景。
  get currentProviderConfig(): ProviderConfig {
    return { ...this.providerConfig };
  }

  // -------------------------------------------------------------------------
  // 大纲
  // -------------------------------------------------------------------------

  getCurriculum(): Curriculum {
    return this.curriculum;
  }

  saveCurriculum(): void {
    this.workspace.writeJSON(this.workspace.curriculumPath, this.curriculum);
  }

  // -------------------------------------------------------------------------
  // 会话
  // -------------------------------------------------------------------------

  /** 会话按需从磁盘加载并缓存在内存。renderLearnEntry 负责把 custom 条目渲染进上下文。 */
  session(sessionId: string): Session {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = Session.load({
        id: sessionId,
        filePath: this.workspace.sessionPath(sessionId),
        renderCustom: renderLearnEntry,
      });
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  // -------------------------------------------------------------------------
  // 跑一轮
  // -------------------------------------------------------------------------

  async runPlannerTurn(message: string, hooks: TurnHooks = {}): Promise<LoopResult> {
    const session = this.session(PLANNER_SESSION_ID);
    await this.compactIfNeeded(session);

    const latestReports = latestReportsByNode(this.curriculum, this.workspace);

    const toolContext: PlannerToolContext = {
      workspace: this.workspace,
      curriculum: this.curriculum,
      dispatchTutor: async (nodeId, instruction) => this.dispatch(nodeId, instruction),
      saveCurriculum: () => this.saveCurriculum(),
      ...(this.vaultAccess ? { vault: this.vaultAccess } : {}),
      workFolder: this.workFolder,
    };

    return this.runTurn({
      session,
      system: buildPlannerSystemPrompt(this.curriculum, latestReports),
      registry: createPlannerRegistry(Boolean(this.vaultAccess)),
      toolContext,
      message,
      reasoningEffort: this.reasoning.planner,
      hooks,
    });
  }

  async runTutorTurn(nodeId: string, message: string, hooks: TurnHooks = {}): Promise<LoopResult> {
    const node = this.requireNode(nodeId);
    const session = this.session(tutorSessionId(nodeId));
    await this.compactIfNeeded(session, node);

    const toolContext: TutorToolContext = {
      workspace: this.workspace,
      node,
      session,
      onStatusChange: (status) => {
        node.status = status;
        this.saveCurriculum();
      },
      ...(this.vaultAccess ? { vault: this.vaultAccess } : {}),
    };

    return this.runTurn({
      session,
      system: buildTutorSystemPrompt(node, this.curriculum.learnerProfile),
      registry: createTutorRegistry(Boolean(this.vaultAccess)),
      toolContext,
      message,
      reasoningEffort: this.reasoning.tutor,
      hooks,
    });
  }

  /**
   * 跑一轮自定义角色的对话。
   *
   * 和规划师/导师走的是同一套循环、同一套会话树、同一套压缩——差别只在系统提示
   * 和工具表。所以自定义角色天然拥有持久会话、上下文压缩、撤销这些能力，不需要
   * 为它单独实现一遍。
   */
  async runCustomRoleTurn(
    role: CustomRole,
    message: string,
    hooks: TurnHooks = {},
  ): Promise<LoopResult> {
    const session = this.session(customRoleSessionId(role.id));
    await this.compactIfNeeded(session);

    const toolContext: CustomRoleToolContext = {
      ...(this.vaultAccess ? { vault: this.vaultAccess } : {}),
      workFolder: this.workFolder,
    };

    return this.runTurn({
      session,
      system: buildCustomRolePrompt(role, this.workFolder),
      registry: createCustomRoleRegistry(Boolean(this.vaultAccess) && role.vaultAccess !== false),
      toolContext,
      message,
      reasoningEffort: this.reasoning.tutor,
      hooks,
    });
  }

  /**
   * 让导师开场。没有真实用户发言，而是追加一条 kickoff 条目——
   * 伪造一条用户消息会让 UI 显示出学习者没说过的话。
   */
  async kickoffTutor(nodeId: string, instruction?: string, hooks: TurnHooks = {}): Promise<LoopResult> {
    const node = this.requireNode(nodeId);
    const session = this.session(tutorSessionId(nodeId));
    await this.compactIfNeeded(session, node);

    const toolContext: TutorToolContext = {
      workspace: this.workspace,
      node,
      session,
      onStatusChange: (status) => {
        node.status = status;
        this.saveCurriculum();
      },
      ...(this.vaultAccess ? { vault: this.vaultAccess } : {}),
    };

    session.appendCustom(
      ENTRY_KICKOFF,
      { instruction: instruction ? `${KICKOFF_INSTRUCTION}\n\n补充交代：${instruction}` : KICKOFF_INSTRUCTION },
      true,
    );

    if (node.status === "pending") {
      node.status = "learning";
      this.saveCurriculum();
    }

    const result = await runAgentLoop({
      provider: this.provider,
      system: buildTutorSystemPrompt(node, this.curriculum.learnerProfile),
      history: session.buildContext(),
      registry: createTutorRegistry(Boolean(this.vaultAccess)),
      toolContext,
      maxIterations: this.maxIterations,
      maxTokens: this.maxOutputTokens,
      reasoningEffort: this.reasoning.tutor,
      cacheKey: session.id,
      ...(hooks.emit ? { emit: hooks.emit } : {}),
      ...(hooks.signal ? { signal: hooks.signal } : {}),
      onMessage: (m) => {
        session.appendMessage(m);
      },
    });

    this.maybeAutoExport();
    return result;
  }

  private async runTurn<TContext>(options: {
    session: Session;
    system: string;
    registry: ToolRegistry<TContext>;
    toolContext: TContext;
    message: string;
    reasoningEffort: ReasoningEffort;
    hooks: TurnHooks;
  }): Promise<LoopResult> {
    const { session, system, message, hooks } = options;

    // 用户消息先落盘再跑循环：即使这一轮崩了，学习者说的话也不会丢
    session.appendMessage(userText(message));

    const result = await runAgentLoop<TContext>({
      provider: this.provider,
      system,
      history: session.buildContext(),
      registry: options.registry,
      toolContext: options.toolContext,
      maxIterations: this.maxIterations,
      maxTokens: this.maxOutputTokens,
      reasoningEffort: options.reasoningEffort,
      // 会话 id 同时作为缓存亲和键：让同一会话的请求粘在同一个后端
      cacheKey: session.id,
      ...(hooks.emit ? { emit: hooks.emit } : {}),
      ...(hooks.signal ? { signal: hooks.signal } : {}),
      onMessage: (m) => {
        session.appendMessage(m);
      },
    });

    this.maybeAutoExport();
    return result;
  }

  /**
   * 上下文接近窗口上限时压缩。
   *
   * 放在每轮请求之前检查，而不是之后：这样能保证即将发出的这次请求一定装得下。
   * 事后压缩则可能出现「已经超了但还没压」的窗口期。
   */
  private async compactIfNeeded(session: Session, node?: KnowledgePoint): Promise<void> {
    const settings = this.compactionSettings();
    const messages = session.buildContext();
    if (!shouldCompact(messages, settings)) return;

    const result = await compactMessages({
      messages,
      provider: this.provider,
      settings,
    });
    if (!result) return;

    session.appendCompaction(result.summary, result.retainedTail, result.tokensBefore);

    // 复用语义：压缩摘要本身就是「刚才讲了什么」的良好概括，直接沉淀成笔记，
    // 不必再花一次模型调用去做笔记总结。
    if (node) appendCompactionToNotes(this.workspace, node.id, result.summary);
  }

  // -------------------------------------------------------------------------
  // 派发与注入
  // -------------------------------------------------------------------------

  /**
   * 把知识点交给导师。这里不做任何后台工作——导师是学习者直接对话的对象，
   * 它的第一轮由学习者或界面的「开场」动作触发，而不是悄悄跑掉。
   */
  private async dispatch(nodeId: string, instruction?: string): Promise<string> {
    const node = this.requireNode(nodeId);
    // 触碰会话以确保文件建立；同时让会话进入内存缓存
    this.session(tutorSessionId(nodeId));

    const prerequisites = node.prerequisites
      .map((id) => this.curriculum.nodes.find((n) => n.id === id))
      .filter((n): n is KnowledgePoint => n !== undefined);

    const lines = [`已为「${node.title}」建立学习会话。`];
    if (instruction) lines.push(`已把你的交代转达给导师。`);
    if (prerequisites.length > 0) {
      const notMastered = prerequisites.filter((p) => p.status !== "mastered");
      if (notMastered.length > 0) {
        lines.push(
          `注意：前置知识点 ${notMastered.map((p) => `「${p.title}」(${p.id})`).join("、")} 尚未掌握，` +
            `导师会在对话中指出。若学习者确实不熟，考虑先用它的笔记做一次注入。`,
        );
      }
    }
    return lines.join("\n");
  }

  async inject(
    sourceId: string,
    targetId: string,
    hint?: string,
    signal?: AbortSignal,
  ): Promise<{ record: InjectionRecord; cached: boolean; alreadyApplied: boolean }> {
    const invalid = validateInjection(this.curriculum, sourceId, targetId);
    if (invalid) throw new Error(invalid);

    const sourceNode = this.requireNode(sourceId);
    const targetNode = this.requireNode(targetId);

    const { essence, cached } = await generateEssence({
      workspace: this.workspace,
      curriculum: this.curriculum,
      sourceNode,
      targetNode,
      ...(hint ? { hint } : {}),
      provider: this.provider,
      ...(signal ? { signal } : {}),
    });

    // 同样的内容已经注入过且还没撤销，就不要再追加一条。
    // 注入是「往上下文里放东西」，重复放两份白占 token，还会让导师看到两段一模一样的
    // 前置知识而困惑。重复点击应该是个无操作，而不是产生副作用。
    const existing = listInjections(this.workspace).find(
      (record) =>
        !record.revokedAt &&
        record.sourceNodeId === sourceId &&
        record.targetNodeId === targetId &&
        record.content === essence.content,
    );
    if (existing) {
      return { record: existing, cached: true, alreadyApplied: true };
    }

    const session = this.session(tutorSessionId(targetId));
    const { record } = applyInjection(session, essence, this.workspace);

    return { record, cached, alreadyApplied: false };
  }

  revokeInjection(injectionId: string): void {
    const record = listInjections(this.workspace).find((r) => r.id === injectionId);
    if (!record) throw new Error(`找不到注入记录 ${injectionId}`);
    if (record.revokedAt) return; // 已撤销，幂等

    const session = this.session(tutorSessionId(record.targetNodeId));
    revokeInjection(session, record, this.workspace);
  }

  // -------------------------------------------------------------------------
  // 给上层的视图
  // -------------------------------------------------------------------------

  snapshot(): RuntimeSnapshot {
    const latestReports = latestReportsByNode(this.curriculum, this.workspace);

    return {
      topic: this.curriculum.topic,
      learnerProfile: this.curriculum.learnerProfile,
      nodes: this.curriculum.nodes.map((node) => ({
        ...node,
        hasNotes: hasNotes(this.workspace, node.id),
        ...(latestReports.get(node.id) ? { latestReport: latestReports.get(node.id)! } : {}),
      })),
      injections: listInjections(this.workspace),
    };
  }

  /**
   * 导出某个会话的分支，供界面渲染。
   *
   * 直接返回条目而不是渲染后的消息：界面对报告、题目、注入的呈现方式和模型看到的
   * 完全不同（比如题目的参考答案要等学习者作答后才显示），这个区分必须在原始条目
   * 层面保留，渲染成消息就丢失了。
   */
  sessionEntries(sessionId: string) {
    return this.session(sessionId).branch();
  }

  notes(nodeId: string): string {
    return readNotes(this.workspace, nodeId);
  }

  private requireNode(nodeId: string): KnowledgePoint {
    const node = this.curriculum.nodes.find((n) => n.id === nodeId);
    if (!node) throw new Error(`找不到知识点 ${nodeId}`);
    return node;
  }
}

export type { NodeStatus, KnowledgePoint };
