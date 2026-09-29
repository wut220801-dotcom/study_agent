/**
 * 左栏的角色列表（可伸缩）。
 *
 * 两种状态：
 *   - 收起：一条窄图标栏，只占 44px，尽量不挤占对话区
 *   - 展开：显示角色名和说明，可以在这里增删改角色
 *
 * 角色分三类，都在这一个列表里：
 *   规划师（内置，全局唯一）
 *   导师（每个知识点一个，跟着大纲走）
 *   自定义角色（用户自己加的，如「总结当前笔记」）
 *
 * 把它们放在同一个列表里，是因为对使用者来说它们没有本质区别——都是「一个可以
 * 对话的对象」。区别只在于内置的那两个行为是设计好的，自定义的是自己写的。
 */

import { Modal, Notice, Setting, setIcon, type App } from "obsidian";

import { customRoleSessionId, newRoleId, type CustomRole } from "../../src/learn/roles.js";
import type LearnAgentPlugin from "./main.js";

export type RoleRef =
  | { kind: "planner" }
  | { kind: "tutor"; nodeId: string }
  | { kind: "custom"; roleId: string };

export function roleRefId(ref: RoleRef): string {
  switch (ref.kind) {
    case "planner":
      return "planner";
    case "tutor":
      return `tutor:${ref.nodeId}`;
    case "custom":
      return `custom:${ref.roleId}`;
  }
}

interface RoleEntry {
  ref: RoleRef;
  name: string;
  icon: string;
  hint?: string;
  /** 自定义角色才有的操作 */
  editable?: CustomRole;
}

export interface RoleListOptions {
  app: App;
  plugin: LearnAgentPlugin;
  selected: RoleRef;
  onSelect: (ref: RoleRef) => void;
  /** 自定义角色被增删改后，需要重画列表和设置表单 */
  onChange: () => void;
}

export class RoleList {
  private expanded = false;

  constructor(
    private root: HTMLElement,
    /** 公开可写：视图切换角色时要同步 selected 并重画 */
    public options: RoleListOptions,
  ) {}

  get isExpanded(): boolean {
    return this.expanded;
  }

  toggle(): void {
    this.expanded = !this.expanded;
    this.render();
  }

  render(): void {
    const { root } = this;
    root.empty();
    root.toggleClass("is-expanded", this.expanded);

    const header = root.createDiv({ cls: "learn-agent-roles-header" });
    const toggleBtn = header.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": this.expanded ? "收起角色栏" : "展开角色栏" },
    });
    setIcon(toggleBtn, this.expanded ? "chevron-left" : "chevron-right");
    toggleBtn.addEventListener("click", () => this.toggle());

    if (this.expanded) {
      header.createSpan({ cls: "learn-agent-roles-title", text: "角色" });
    }

    const list = root.createDiv({ cls: "learn-agent-roles-list" });

    for (const entry of this.entries()) {
      const isActive = roleRefId(entry.ref) === roleRefId(this.options.selected);

      const item = list.createDiv({
        cls: `learn-agent-role${isActive ? " is-active" : ""}`,
        attr: { "aria-label": entry.name },
      });

      const iconEl = item.createDiv({ cls: "learn-agent-role-icon" });
      setIcon(iconEl, entry.icon);

      if (this.expanded) {
        const text = item.createDiv({ cls: "learn-agent-role-text" });
        text.createDiv({ cls: "learn-agent-role-name", text: entry.name });
        if (entry.hint) {
          text.createDiv({ cls: "learn-agent-role-hint", text: entry.hint });
        }

        if (entry.editable) {
          const actions = item.createDiv({ cls: "learn-agent-role-actions" });

          const editBtn = actions.createEl("button", {
            cls: "clickable-icon",
            attr: { "aria-label": "编辑" },
          });
          setIcon(editBtn, "pencil");
          editBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            this.openRoleEditor(entry.editable!, false);
          });

          const delBtn = actions.createEl("button", {
            cls: "clickable-icon",
            attr: { "aria-label": "删除" },
          });
          setIcon(delBtn, "trash-2");
          delBtn.addEventListener("click", async (event) => {
            event.stopPropagation();
            const roles = this.options.plugin.settings.customRoles.filter(
              (r) => r.id !== entry.editable!.id,
            );
            await this.options.plugin.updateSettings({ customRoles: roles });
            // 删掉的正是当前选中的角色，退回规划师
            if (
              this.options.selected.kind === "custom" &&
              this.options.selected.roleId === entry.editable!.id
            ) {
              this.options.onSelect({ kind: "planner" });
            }
            new Notice(`已删除角色「${entry.name}」（它的会话记录还在磁盘上）`);
            this.options.onChange();
          });
        }
      }

      item.addEventListener("click", () => {
        // 收起状态下点图标先展开，符合「先看到有什么，再选」的直觉
        if (!this.expanded) {
          this.toggle();
          return;
        }
        this.options.onSelect(entry.ref);
      });
    }

    if (this.expanded) {
      const addBtn = list.createDiv({ cls: "learn-agent-role learn-agent-role-add" });
      const addIcon = addBtn.createDiv({ cls: "learn-agent-role-icon" });
      setIcon(addIcon, "plus");
      const addText = addBtn.createDiv({ cls: "learn-agent-role-text" });
      addText.createDiv({ cls: "learn-agent-role-name", text: "新增角色" });
      addText.createDiv({ cls: "learn-agent-role-hint", text: "自定义提示词与工具" });
      addBtn.addEventListener("click", () => this.openRoleEditor(null, true));
    }
  }

  /** 组装当前应该显示的角色条目。 */
  private entries(): RoleEntry[] {
    const out: RoleEntry[] = [];
    const curriculum = this.options.plugin.runtime.getCurriculum();

    out.push({
      ref: { kind: "planner" },
      name: "规划师",
      icon: "compass",
      hint: "管理大纲与学习计划",
    });

    // 导师跟着大纲走：每个知识点一个
    for (const node of curriculum.nodes) {
      out.push({
        ref: { kind: "tutor", nodeId: node.id },
        name: node.title,
        icon: node.status === "mastered" ? "check-circle" : "graduation-cap",
        hint: `${node.id} · 导师`,
      });
    }

    for (const role of this.options.plugin.settings.customRoles) {
      out.push({
        ref: { kind: "custom", roleId: role.id },
        name: role.name,
        icon: role.icon?.trim() || "message-square",
        hint: role.attachActiveNote ? "自动附带当前笔记" : "自定义角色",
        editable: role,
      });
    }

    return out;
  }

  /**
   * 角色编辑弹窗。
   *
   * 用 Obsidian 的 Modal 而不是塞进设置页——新增角色是「现在就想加一个」的动作，
   * 不该把人赶到设置里去。写提示词需要空间，弹窗比右栏里的输入框合适。
   */
  private openRoleEditor(role: CustomRole | null, isNew: boolean): void {
    const draft: CustomRole = role
      ? { ...role }
      : {
          id: newRoleId(),
          name: "",
          icon: "message-square",
          systemPrompt: "",
          attachActiveNote: true,
          vaultAccess: true,
        };

    const modal = new Modal(this.options.app);
    modal.titleEl.setText(isNew ? "新增对话角色" : "编辑角色");

    const { contentEl } = modal;

    new Setting(contentEl)
      .setName("名称")
      .setDesc("会显示在左栏")
      .addText((text) => {
        text.setValue(draft.name);
        text.setPlaceholder("例如：笔记总结");
        text.onChange((value) => {
          draft.name = value;
        });
      });

    new Setting(contentEl)
      .setName("图标")
      .setDesc("lucide 图标名，如 file-text / list / languages / lightbulb")
      .addText((text) => {
        text.setValue(draft.icon ?? "");
        text.setPlaceholder("message-square");
        text.onChange((value) => {
          draft.icon = value.trim();
        });
      });

    new Setting(contentEl)
      .setName("系统提示")
      .setDesc("这个角色是干什么的、该怎么回应。写得越具体，它越像你要的那个人。")
      .addTextArea((area) => {
        area.setValue(draft.systemPrompt);
        area.setPlaceholder(
          "例如：\n你是一个笔记整理助手。学习者会给你一篇笔记或一段内容，" +
            "你要把它压缩成结构清晰的要点，保留具体的名称、数字和结论，" +
            "删掉铺垫和重复。输出用 markdown，不要加评论。",
        );
        area.inputEl.rows = 8;
        area.inputEl.style.width = "100%";
        area.onChange((value) => {
          draft.systemPrompt = value;
        });
      });

    new Setting(contentEl)
      .setName("自动附带当前笔记")
      .setDesc("打开时，每轮都把你当前打开的笔记内容附在消息前面——不用先复制粘贴。")
      .addToggle((toggle) => {
        toggle.setValue(Boolean(draft.attachActiveNote));
        toggle.onChange((value) => {
          draft.attachActiveNote = value;
        });
      });

    new Setting(contentEl)
      .setName("允许查看笔记库")
      .setDesc("给它看目录结构和按需读单篇的能力。只读，不能改你的笔记。")
      .addToggle((toggle) => {
        toggle.setValue(draft.vaultAccess !== false);
        toggle.onChange((value) => {
          draft.vaultAccess = value;
        });
      });

    new Setting(contentEl).addButton((button) => {
      button.setButtonText(isNew ? "创建" : "保存").setCta().onClick(async () => {
        if (!draft.name.trim()) {
          new Notice("名称不能为空");
          return;
        }
        if (!draft.systemPrompt.trim()) {
          new Notice("系统提示不能为空——那才是这个角色的行为定义");
          return;
        }

        const roles = [...this.options.plugin.settings.customRoles];
        const index = roles.findIndex((r) => r.id === draft.id);
        if (index >= 0) roles[index] = draft;
        else roles.push(draft);

        await this.options.plugin.updateSettings({ customRoles: roles });
        modal.close();

        // 新建完直接切过去，省一步点击
        if (isNew) this.options.onSelect({ kind: "custom", roleId: draft.id });
        else this.options.onChange();
      });
    });

    modal.open();
  }

  /** 当前选中的角色条目（给视图查提示用）。 */
  find(ref: RoleRef): RoleEntry | undefined {
    return this.entries().find((e) => roleRefId(e.ref) === roleRefId(ref));
  }
}

export { customRoleSessionId };
