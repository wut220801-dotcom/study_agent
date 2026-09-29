/**
 * 插件入口。
 *
 * 「全部跑在插件里」的完整链路在这里合拢：
 *   ribbon 图标 / 命令 → 右栏 ItemView → 直接调用进程内的 LearningRuntime
 * 没有服务端、没有 HTTP、没有 SSE——一轮对话就是一次函数调用。
 */

import { Notice, Plugin, TFile, type WorkspaceLeaf } from "obsidian";

import { isGeneratedFile, renderVaultFiles } from "../../src/learn/obsidian.js";
import { createVaultAccess, ensureFolder } from "./vault.js";
import type { LearningRuntime } from "../../src/learn/runtime.js";
import {
  DEFAULT_SETTINGS,
  createRuntime,
  stateDir,
  vaultBasePath,
  type LearnAgentSettings,
} from "./bootstrap.js";
import { LearnAgentSettingTab } from "./settings-tab.js";
import { LearnAgentView, VIEW_TYPE_LEARN_AGENT, activateView } from "./view.js";

export default class LearnAgentPlugin extends Plugin {
  settings: LearnAgentSettings = { ...DEFAULT_SETTINGS };
  runtime!: LearningRuntime;

  /** 状态目录的绝对路径，用于告诉 runtime 把会话写哪去。 */
  private get dataDir(): string {
    return stateDir(this.app, this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`);
  }

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.rebuildRuntime();

    this.registerView(VIEW_TYPE_LEARN_AGENT, (leaf: WorkspaceLeaf) => {
      return new LearnAgentView(leaf, this);
    });

    // 左侧 ribbon 图标，点一下右栏弹出对话面板——这就是你要的入口
    this.addRibbonIcon("graduation-cap", "学习 Agent", () => {
      void activateView(this);
    });

    this.addCommand({
      id: "open-panel",
      name: "打开学习 Agent 面板",
      callback: () => void activateView(this),
    });

    // 把选中的内容直接发给当前对话对象——住在笔记里最大的价值，不用复制粘贴
    this.addCommand({
      id: "ask-with-selection",
      name: "把选中内容发给学习 Agent",
      editorCallback: async (editor) => {
        const selection = editor.getSelection().trim();
        if (!selection) {
          new Notice("先选中一段内容");
          return;
        }
        await activateView(this);
        const view = this.getView();
        if (!view) return;
        await view.askSelection(selection);
      },
    });

    this.addSettingTab(new LearnAgentSettingTab(this.app, this));

    // 状态目录可能还不存在，第一次跑之前先建好
    try {
      await this.ensureDataDir();
    } catch (error) {
      new Notice(
        `学习 Agent：状态目录创建失败——${error instanceof Error ? error.message : String(error)}`,
        10000,
      );
    }
  }

  override onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_LEARN_AGENT);
  }

  private getView(): LearnAgentView | null {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_LEARN_AGENT)[0];
    return leaf?.view instanceof LearnAgentView ? leaf.view : null;
  }

  // -------------------------------------------------------------------------
  // 设置与 runtime 生命周期
  // -------------------------------------------------------------------------

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<LearnAgentSettings> | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(stored ?? {}),
      reasoning: { ...DEFAULT_SETTINGS.reasoning, ...(stored?.reasoning ?? {}) },
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * 改配置的统一入口：合并 → 落盘 → 重建 runtime → 通知面板。
   * 面板内表单和设置页都走这里，所以两边永远一致。
   */
  async updateSettings(patch: Partial<LearnAgentSettings>): Promise<void> {
    this.settings = {
      ...this.settings,
      ...patch,
      reasoning: { ...this.settings.reasoning, ...(patch.reasoning ?? {}) },
    };
    await this.saveSettings();
    this.rebuildRuntime();
  }

  /** 配置变了就重建 runtime。会话状态在磁盘上，所以重装不会丢对话。 */
  rebuildRuntime(): void {
    this.runtime = createRuntime(
      this.app,
      this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`,
      this.settings,
    );
    // 把「能看库」这件事交给 runtime。有它，规划和导师的工具表里才会多出
    // 看笔记库结构、读笔记的那两个工具——这是 agent 和工作目录产生关联的地方。
    this.runtime.setVaultAccess(
      createVaultAccess(this.app),
      this.settings.notesFolder.trim() || DEFAULT_SETTINGS.notesFolder,
    );
    this.getView()?.onRuntimeChanged(this.runtime);
  }

  private async ensureDataDir(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const relative = this.dataDir.slice(vaultBasePath(this.app).length + 1);
    if (!(await adapter.exists(relative))) {
      await adapter.mkdir(relative);
    }
  }

  // -------------------------------------------------------------------------
  // 把学习笔记写进库里
  // -------------------------------------------------------------------------

  /**
   * 把导师的笔记写进库，用 Obsidian 自己的文件 API 而不是 node:fs。
   *
   * 这一点很关键：走 node:fs 直接写盘，Obsidian 的文件索引不会立刻知道，
   * 新建的笔记在文件树里看不到、搜不到，还可能跟同步功能打架。
   *
   * 仍然复用主项目的渲染逻辑（frontmatter、双链、依赖表格），只是把「写文件」
   * 这一步换成 vault API，并且保留同样的防覆盖保护——库里全是用户自己的笔记，
   * 同名文件没有生成标记就跳过。
   */
  async writeNotesToVault(): Promise<{ written: number; skipped: number; error?: string }> {
    if (!this.settings.autoWriteNotes) return { written: 0, skipped: 0 };

    const folder = this.settings.notesFolder.trim() || DEFAULT_SETTINGS.notesFolder;

    try {
      // 渲染复用主项目那一份（已被断言覆盖：frontmatter、双链、进度表格），
      // 这里只把「写文件」换成 vault API。
      const files = renderVaultFiles(this.runtime.getCurriculum(), this.runtime.workspace, folder);

      let written = 0;
      let skipped = 0;
      await ensureFolder(this.app, folder);

      for (const [relative, content] of files) {
        const existing = this.app.vault.getAbstractFileByPath(relative);
        if (existing === null) {
          await this.app.vault.create(relative, content);
          written++;
          continue;
        }
        if (!(existing instanceof TFile)) {
          skipped++;
          continue;
        }
        const previous = await this.app.vault.read(existing);
        // 同样的防覆盖规则：没有生成标记的同名文件是你自己的，不碰
        if (!isGeneratedFile(previous)) {
          skipped++;
          continue;
        }
        await this.app.vault.modify(existing, content);
        written++;
      }

      return { written, skipped };
    } catch (error) {
      return {
        written: 0,
        skipped: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** 供设置页调用的连通性检查。 */
  describeStateDir(): string {
    return this.dataDir;
  }
}
