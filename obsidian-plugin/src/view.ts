/**
 * 右侧栏的 agent 面板。
 *
 * 布局：左边一条可伸缩的角色栏，右边是对话。角色栏收起时只占 44px（一排图标），
 * 展开后显示角色名和说明，也能在这里增删自定义角色。
 *
 * 三个刻意为之的技术选择：
 *
 * 1. **用 Obsidian 的 MarkdownRenderer**，于是 agent 输出里的 `[[双链]]` 是可点的。
 *    这是待在 Obsidian 里最大的红利，用第三方 markdown 库就全丢了。
 *
 * 2. **手写 DOM，不引 React。** 省掉框架体积和版本冲突，而且用 Obsidian 的 CSS 变量
 *    能让面板自动跟随主题——深浅色都不必另做一套。
 *
 * 3. **角色是数据。** 三类角色（规划师 / 各知识点的导师 / 用户自定义）在同一个列表里，
 *    对使用者来说没有本质区别，都是「一个可以对话的对象」。
 */

import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, setIcon } from "obsidian";

import type { LoopEvent } from "../../src/core/loop.js";
import type { LearningRuntime } from "../../src/learn/runtime.js";
import { customRoleSessionId, type CustomRole } from "../../src/learn/roles.js";
import { PLANNER_SESSION_ID, tutorSessionId } from "../../src/learn/types.js";
import type LearnAgentPlugin from "./main.js";
import { RoleList, type RoleRef } from "./role-list.js";
import { renderSettingsForm } from "./settings-form.js";

export const VIEW_TYPE_LEARN_AGENT = "learn-agent-view";

/** 自动附带当前笔记时的内容上限。太长会挤掉真正的对话。 */
const ACTIVE_NOTE_MAX_CHARS = 8000;

export class LearnAgentView extends ItemView {
  private runtime: LearningRuntime;
  private role: RoleRef = { kind: "planner" };

  private roleListEl!: HTMLElement;
  private roleList!: RoleList;
  private listEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private settingsEl!: HTMLElement;
  private composerEl!: HTMLElement;
  private gearBtn!: HTMLButtonElement;

  private showingSettings = false;
  private streaming = false;
  private streamEl: HTMLElement | null = null;
  private streamText = "";

  constructor(leaf: WorkspaceLeaf, private plugin: LearnAgentPlugin) {
    super(leaf);
    this.runtime = plugin.runtime;
  }

  getViewType(): string {
    return VIEW_TYPE_LEARN_AGENT;
  }

  getDisplayText(): string {
    return "学习 Agent";
  }

  getIcon(): string {
    return "graduation-cap";
  }

  async onOpen(): Promise<void> {
    this.buildLayout();
    await this.renderConversation();
    this.inputEl.focus();
  }

  onRuntimeChanged(runtime: LearningRuntime): void {
    this.runtime = runtime;
    // 大纲变了，导师列表跟着变
    this.roleList?.render();
    void this.renderConversation();
  }

  // -------------------------------------------------------------------------
  // 布局
  // -------------------------------------------------------------------------

  private buildLayout(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("learn-agent-root");

    // 左栏：角色
    this.roleListEl = root.createDiv({ cls: "learn-agent-roles" });
    this.roleList = new RoleList(this.roleListEl, {
      app: this.app,
      plugin: this.plugin,
      selected: this.role,
      onSelect: (ref) => {
        this.role = ref;
        this.roleList.options.selected = ref;
        this.roleList.render();
        void this.renderConversation();
        this.inputEl.focus();
      },
      onChange: () => this.roleList.render(),
    });

    // 右栏：对话
    const main = root.createDiv({ cls: "learn-agent-main" });

    const header = main.createDiv({ cls: "learn-agent-header" });
    this.statusEl = header.createDiv({ cls: "learn-agent-status" });

    const actions = header.createDiv({ cls: "learn-agent-header-actions" });

    this.gearBtn = actions.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": "设置" },
    });
    setIcon(this.gearBtn, "settings");
    this.gearBtn.addEventListener("click", () => this.toggleSettings());

    const refreshBtn = actions.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": "刷新" },
    });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.addEventListener("click", () => {
      this.roleList.render();
      void this.renderConversation();
    });

    // 设置区（与消息区互斥显示）
    this.settingsEl = main.createDiv({ cls: "learn-agent-settings" });
    this.settingsEl.style.display = "none";

    this.listEl = main.createDiv({ cls: "learn-agent-messages" });

    this.composerEl = main.createDiv({ cls: "learn-agent-composer" });
    this.inputEl = this.composerEl.createEl("textarea", {
      cls: "learn-agent-input",
      attr: { rows: "1", placeholder: "说点什么…（Enter 发送，Shift+Enter 换行）" },
    });
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void this.send();
      }
    });
    this.inputEl.addEventListener("input", () => {
      this.inputEl.style.height = "auto";
      this.inputEl.style.height = `${Math.min(this.inputEl.scrollHeight, 200)}px`;
    });

    this.sendBtn = this.composerEl.createEl("button", {
      cls: "mod-cta learn-agent-send",
      text: "发送",
    });
    this.sendBtn.addEventListener("click", () => void this.send());

    this.roleList.render();
  }

  private toggleSettings(): void {
    this.showingSettings = !this.showingSettings;

    this.settingsEl.style.display = this.showingSettings ? "" : "none";
    this.listEl.style.display = this.showingSettings ? "none" : "";
    this.composerEl.style.display = this.showingSettings ? "none" : "";
    this.gearBtn.toggleClass("is-active", this.showingSettings);

    if (this.showingSettings) {
      this.statusEl.setText("设置");
      this.paintSettings();
    } else {
      this.updateStatus();
      this.inputEl.focus();
    }
  }

  private paintSettings(): void {
    renderSettingsForm(this.settingsEl, {
      app: this.app,
      getSettings: () => this.plugin.settings,
      commit: (next) => this.plugin.updateSettings(next),
      rerender: () => this.paintSettings(),
    });
  }

  // -------------------------------------------------------------------------
  // 会话
  // -------------------------------------------------------------------------

  // 都先取到局部变量再收窄：this.role 是可变的，TS 不会跨属性读取保持收窄
  private sessionId(): string {
    const role = this.role;
    switch (role.kind) {
      case "planner":
        return PLANNER_SESSION_ID;
      case "tutor":
        return tutorSessionId(role.nodeId);
      case "custom":
        return customRoleSessionId(role.roleId);
    }
  }

  private currentCustomRole(): CustomRole | null {
    const role = this.role;
    if (role.kind !== "custom") return null;
    return this.plugin.settings.customRoles.find((r) => r.id === role.roleId) ?? null;
  }

  private roleName(): string {
    const role = this.role;
    switch (role.kind) {
      case "planner":
        return "规划师";
      case "tutor": {
        const node = this.runtime.getCurriculum().nodes.find((n) => n.id === role.nodeId);
        return node ? `导师 · ${node.title}` : "导师";
      }
      case "custom":
        return this.currentCustomRole()?.name ?? "（角色已删除）";
    }
  }

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  private async renderConversation(): Promise<void> {
    this.listEl.empty();

    // 角色被删了：给个明确提示，别显示一个不存在的对话
    const current = this.role;
    if (current.kind === "custom" && !this.currentCustomRole()) {
      this.listEl.createDiv({ cls: "learn-agent-empty", text: "这个角色已被删除。" });
      this.updateStatus();
      return;
    }

    const entries = this.runtime.sessionEntries(this.sessionId());

    if (entries.length === 0) {
      this.listEl.createDiv({ cls: "learn-agent-empty", text: this.emptyHint() });
      this.updateStatus();
      return;
    }

    for (const entry of entries) {
      switch (entry.type) {
        case "message": {
          const text = entry.message.content
            .filter((b) => b.type === "text")
            .map((b) => (b as { text: string }).text)
            .join("");
          if (!text.trim()) break; // 纯工具结果的消息不展示
          await this.appendBubble(entry.message.role === "user" ? "user" : "agent", text);
          break;
        }
        case "compaction":
          this.listEl.createDiv({
            cls: "learn-agent-marker",
            text: `上下文已压缩（${entry.tokensBefore.toLocaleString()} tokens → 摘要）`,
          });
          break;
        case "custom":
          this.renderCustomEntry(entry.customType, entry.data);
          break;
      }
    }

    this.scrollToBottom();
    this.updateStatus();
  }

  private emptyHint(): string {
    const role = this.role;
    switch (role.kind) {
      case "planner":
        return "告诉规划师你想学什么。说清楚目的和现在的水平，他才能把大纲拆对。";
      case "tutor": {
        const node = this.runtime.getCurriculum().nodes.find((n) => n.id === role.nodeId);
        return node ? `开始学「${node.title}」。` : "这个知识点已经不在大纲里了。";
      }
      case "custom": {
        const role = this.currentCustomRole();
        if (role?.attachActiveNote) {
          return (
            "直接说你想做什么——「总结一下」「梳理成清单」「这段什么意思」。\n\n" +
            "你当前打开的笔记会自动附在消息里，不用先复制粘贴。"
          );
        }
        return `和「${role?.name ?? "这个角色"}」开始对话。`;
      }
    }
  }

  private renderCustomEntry(customType: string, data: Record<string, unknown>): void {
    switch (customType) {
      case "injected_knowledge":
        this.listEl.createDiv({
          cls: "learn-agent-marker learn-agent-injection",
          text: `已注入前置知识 · 来自「${String(data.sourceNodeTitle ?? "")}」`,
        });
        break;
      case "report":
        this.listEl.createDiv({
          cls: "learn-agent-marker",
          text: `已向规划师上报：${String(data.summary ?? "")}`,
        });
        break;
      case "question":
        this.listEl.createDiv({
          cls: "learn-agent-marker learn-agent-question",
          text: `练习：${String(data.question ?? "")}`,
        });
        break;
      case "kickoff":
        break;
    }
  }

  private async appendBubble(role: "user" | "agent", markdown: string): Promise<HTMLElement> {
    const wrap = this.listEl.createDiv({ cls: `learn-agent-msg learn-agent-${role}` });
    const body = wrap.createDiv({ cls: "learn-agent-bubble" });

    if (role === "user") {
      body.setText(markdown);
    } else {
      // sourcePath 传空串：双链按名字解析，库里笔记名是全局唯一的
      await MarkdownRenderer.render(this.app, markdown, body, "", this);
    }
    return body;
  }

  private scrollToBottom(): void {
    this.listEl.scrollTop = this.listEl.scrollHeight;
  }

  private updateStatus(): void {
    this.statusEl.setText(this.roleName());
  }

  // -------------------------------------------------------------------------
  // 一轮对话
  // -------------------------------------------------------------------------

  /**
   * 把当前打开的笔记内容包成一段附在消息前面。
   *
   * 这是「总结当前内容」这类角色能好用的关键：不用先复制粘贴、再描述「我在看哪篇」。
   * 界面上仍然只显示用户原话（那才是他说的），实际发出去的是带上下文的那份。
   */
  private async withActiveNote(message: string): Promise<string> {
    const file = this.app.workspace.getActiveFile();
    if (!file) return message;

    const content = await this.app.vault.cachedRead(file);
    const truncated =
      content.length > ACTIVE_NOTE_MAX_CHARS
        ? `${content.slice(0, ACTIVE_NOTE_MAX_CHARS)}\n\n[... 笔记较长，已截断，原文共 ${content.length} 字符]`
        : content;

    const selection = this.app.workspace.activeEditor?.editor?.getSelection()?.trim();

    const parts = [`（当前笔记：[[${file.basename}]]）`, "", "<note>", truncated, "</note>"];
    if (selection) {
      parts.push("", "学习者当前选中的部分：", "", "<selection>", selection, "</selection>");
    }
    parts.push("", message);
    return parts.join("\n");
  }

  private async send(): Promise<void> {
    const message = this.inputEl.value.trim();
    if (!message || this.streaming) return;

    const settings = this.plugin.settings;
    if (settings.providerKind !== "mock" && !settings.apiKey.trim()) {
      new Notice("还没有配置模型。点右上角齿轮，填入 API key（或先用演示模式）。", 8000);
      return;
    }

    this.inputEl.value = "";
    this.inputEl.style.height = "auto";
    if (this.listEl.querySelector(".learn-agent-empty")) this.listEl.empty();

    const outgoing = this.currentCustomRole()?.attachActiveNote
      ? await this.withActiveNote(message)
      : message;

    await this.appendBubble("user", message);

    this.streaming = true;
    this.sendBtn.disabled = true;
    this.sendBtn.setText("…");

    const wrap = this.listEl.createDiv({ cls: "learn-agent-msg learn-agent-agent" });
    this.streamEl = wrap.createDiv({ cls: "learn-agent-bubble" });
    this.streamText = "";
    const toolsEl = wrap.createDiv({ cls: "learn-agent-tools" });
    this.scrollToBottom();

    // 固定住这一轮用的角色：流式过程中用户切角色的话，不该把回复写进新角色的会话
    const role = this.role;

    try {
      const onEvent = async (event: LoopEvent): Promise<void> => {
        if (event.type === "text_delta") {
          this.streamText += event.text;
          // 流式期间按纯文本渲染（每帧跑完整 markdown 解析太重），结束后再正式渲染
          this.streamEl!.setText(this.streamText);
          this.scrollToBottom();
        } else if (event.type === "tool_start") {
          toolsEl.createSpan({ cls: "learn-agent-tool", text: this.toolLabel(event.name) });
          this.scrollToBottom();
        }
      };

      const run = (() => {
        switch (role.kind) {
          case "planner":
            return this.runtime.runPlannerTurn(outgoing, { emit: onEvent });
          case "tutor":
            return this.runtime.runTutorTurn(role.nodeId, outgoing, { emit: onEvent });
          case "custom": {
            const customRole = this.plugin.settings.customRoles.find((r) => r.id === role.roleId);
            if (!customRole) throw new Error("角色已被删除");
            return this.runtime.runCustomRoleTurn(customRole, outgoing, { emit: onEvent });
          }
        }
      })();

      const result = await run;
      if (result.error) new Notice(`学习 Agent：${result.error}`, 8000);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      new Notice(`学习 Agent 出错：${detail}`, 10000);
      this.streamEl.setText(`⚠️ ${detail}`);
    } finally {
      this.streaming = false;
      this.sendBtn.disabled = false;
      this.sendBtn.setText("发送");
      this.streamEl = null;
      this.streamText = "";
    }

    await this.renderConversation();
    // 规划师可能新建了知识点，角色列表要跟着更新（新导师会出现）
    this.roleList.render();
    await this.plugin.writeNotesToVault();
  }

  private toolLabel(name: string): string {
    const labels: Record<string, string> = {
      save_note: "记笔记",
      read_notes: "读笔记",
      ask_learner: "出题",
      report_progress: "上报进度",
      add_knowledge_point: "新增知识点",
      update_knowledge_point: "修改知识点",
      dispatch_tutor: "派发导师",
      read_reports: "查历史报告",
      set_learning_goal: "记录学习目标",
      list_vault_structure: "看笔记库",
      read_vault_note: "读笔记",
      list_learner_notes: "看笔记库",
    };
    return labels[name] ?? name;
  }

  /** 命令面板触发：把选中内容发给当前角色。 */
  async askSelection(selection: string): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    const parts: string[] = [];
    if (file) parts.push(`（当前笔记：[[${file.basename}]]）`);
    parts.push("下面这段我不太理解，帮我讲讲：", "", "```", selection, "```");
    this.inputEl.value = parts.join("\n");
    await this.send();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }
}

/** 打开（或聚焦）右侧栏的面板。 */
export async function activateView(plugin: LearnAgentPlugin): Promise<void> {
  const { workspace } = plugin.app;
  const existing = workspace.getLeavesOfType(VIEW_TYPE_LEARN_AGENT);

  if (existing.length > 0) {
    await workspace.revealLeaf(existing[0]!);
    return;
  }

  const leaf = workspace.getRightLeaf(false);
  if (!leaf) {
    new Notice("无法在右侧栏打开学习 Agent");
    return;
  }
  await leaf.setViewState({ type: VIEW_TYPE_LEARN_AGENT, active: true });
  await workspace.revealLeaf(leaf);
}
