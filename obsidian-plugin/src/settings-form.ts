/**
 * 设置表单。
 *
 * 抽成独立模块的理由：同一套控件要在两个地方出现——Obsidian 的设置页，以及
 * **面板内的设置区**。后面那个才是日常入口：工作目录、换模型这类事是干活的时候
 * 想改的，每次都要绕进 Obsidian 设置里很烦。
 *
 * 两份 UI 绑的是同一个 `plugin.settings`，通过同一个 `saveSettings()` 落盘，
 * 所以不存在「两套状态不同步」的问题——只是同一份配置渲染了两次。
 */

import { Notice, Setting, type App } from "obsidian";

import type { ReasoningEffort, ThinkingFormat } from "../../src/core/provider/types.js";
import { REASONING_VALUES } from "../../src/settings.js";
import { DEFAULT_SETTINGS, type LearnAgentSettings } from "./bootstrap.js";
import { ensureFolder, listVaultFolders } from "./vault.js";

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  off: "关闭",
  low: "低",
  high: "高（默认）",
  max: "最高",
};

const KIND_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI 兼容（含 DeepSeek）",
  mock: "演示模式",
};

const THINKING_FORMAT_LABELS: Record<string, string> = {
  auto: "自动（按地址推断）",
  deepseek: "DeepSeek（thinking.type 字段）",
  openai: "OpenAI（reasoning_effort）",
  none: "不发送（兼容服务不认时选它）",
};

export const PRESETS: Array<{
  label: string;
  kind: "anthropic" | "openai" | "mock";
  model: string;
  baseUrl: string;
  contextWindow: number;
}> = [
  {
    label: "DeepSeek（官方，推荐）",
    kind: "openai",
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
    contextWindow: 1_000_000,
  },
  {
    label: "DeepSeek（Anthropic 兼容）",
    kind: "anthropic",
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com/anthropic",
    contextWindow: 1_000_000,
  },
  {
    label: "Anthropic 官方",
    kind: "anthropic",
    model: "claude-sonnet-4-5",
    baseUrl: "",
    contextWindow: 200_000,
  },
];

/** 表单需要宿主提供的能力。面板和设置页各自提供一份。 */
export interface SettingsFormHost {
  app: App;
  getSettings(): LearnAgentSettings;
  /** 保存并让改动生效（重建 runtime）。 */
  commit(next: Partial<LearnAgentSettings>): Promise<void>;
  /** 表单需要重画时的回调（例如切换了提供方，要显示/隐藏 key 输入框）。 */
  rerender(): void;
}

export function renderSettingsForm(container: HTMLElement, host: SettingsFormHost): void {
  const settings = host.getSettings();
  container.empty();

  // ---- 工作目录 ----
  container.createEl("h4", { text: "工作目录" });
  container.createEl("p", {
    cls: "setting-item-description",
    text: "导师的笔记写进这里；规划师也从这个目录开始了解你的笔记怎么组织。",
  });

  const folders = listVaultFolders(host.app);
  const current = settings.notesFolder.trim() || DEFAULT_SETTINGS.notesFolder;
  const NEW_OPTION = "__new__";

  new Setting(container)
    .setName("目录")
    .setDesc(folders.includes(current) ? current : `${current}（尚不存在，会新建）`)
    .addDropdown((dropdown) => {
      dropdown.addOption(NEW_OPTION, "＋ 新建目录…");
      for (const folder of folders) dropdown.addOption(folder, folder);
      dropdown.setValue(folders.includes(current) ? current : NEW_OPTION);
      dropdown.onChange(async (value) => {
        if (value === NEW_OPTION) {
          showNewFolderInput(container, host);
          return;
        }
        await ensureFolder(host.app, value);
        await host.commit({ notesFolder: value });
        new Notice(`工作目录已设为「${value}」`);
        host.rerender();
      });
    });

  if (!folders.includes(current)) showNewFolderInput(container, host);

  new Setting(container)
    .setName("每轮自动写入")
    .setDesc("关掉则笔记只留在 agent 内部，不写进库。")
    .addToggle((toggle) => {
      toggle.setValue(settings.autoWriteNotes);
      toggle.onChange(async (value) => {
        await host.commit({ autoWriteNotes: value });
      });
    });

  // ---- 模型 ----
  container.createEl("h4", { text: "模型" });

  new Setting(container)
    .setName("快速填充")
    .setDesc("填入地址、模型名和上下文窗口；key 仍需你自己填。")
    .addDropdown((dropdown) => {
      dropdown.addOption("", "选择预设…");
      for (const preset of PRESETS) dropdown.addOption(preset.label, preset.label);
      dropdown.setValue("");
      dropdown.onChange(async (value) => {
        const preset = PRESETS.find((p) => p.label === value);
        if (!preset) return;
        await host.commit({
          providerKind: preset.kind,
          model: preset.model,
          baseUrl: preset.baseUrl,
          contextWindow: preset.contextWindow,
        });
        host.rerender();
      });
    });

  new Setting(container)
    .setName("提供方")
    .addDropdown((dropdown) => {
      for (const [value, label] of Object.entries(KIND_LABELS)) {
        dropdown.addOption(value, label);
      }
      dropdown.setValue(settings.providerKind);
      dropdown.onChange(async (value) => {
        await host.commit({ providerKind: value as LearnAgentSettings["providerKind"] });
        host.rerender();
      });
    });

  if (settings.providerKind !== "mock") {
    new Setting(container)
      .setName("API key")
      .setDesc("只存在本机。")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(settings.apiKey);
        text.onChange(async (value) => {
          await host.commit({ apiKey: value.trim() });
        });
      });

    new Setting(container).setName("模型名").addText((text) => {
      text.setValue(settings.model);
      text.onChange(async (value) => {
        await host.commit({ model: value.trim() });
      });
    });

    new Setting(container)
      .setName("baseUrl")
      .setDesc("留空用官方地址。")
      .addText((text) => {
        text.setValue(settings.baseUrl);
        text.onChange(async (value) => {
          await host.commit({ baseUrl: value.trim() });
        });
      });

    new Setting(container)
      .setName("上下文窗口")
      .setDesc("决定压缩时机。DeepSeek V4 是 1,000,000——填错会让压缩过早或请求超限。")
      .addText((text) => {
        text.inputEl.type = "number";
        text.setValue(String(settings.contextWindow));
        text.onChange(async (value) => {
          const parsed = Number(value);
          if (!Number.isFinite(parsed)) return;
          await host.commit({ contextWindow: Math.max(8000, Math.floor(parsed)) });
        });
      });

    new Setting(container)
      .setName("测试连接")
      .setDesc("发一条最小请求，验证 key / 模型名 / 地址。")
      .addButton((button) => {
        button.setButtonText("测试").onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("…");
          try {
            const { probeProvider } = await import("../../src/server/probe.js");
            const s = host.getSettings();
            const result = await probeProvider({
              kind: s.providerKind,
              model: s.model,
              apiKey: s.apiKey,
              ...(s.baseUrl ? { baseUrl: s.baseUrl } : {}),
            });
            new Notice(result.message, result.ok ? 6000 : 12000);
          } catch (error) {
            new Notice(`测试失败：${error instanceof Error ? error.message : String(error)}`, 12000);
          } finally {
            button.setDisabled(false);
            button.setButtonText("测试");
          }
        });
      });
  }

  // ---- 推理强度 ----
  container.createEl("h4", { text: "推理强度" });
  container.createEl("p", {
    cls: "setting-item-description",
    text: "回答前花多少 token 思考。是拿延迟和费用换多步推理的准确率，不是「提升智力」。",
  });

  new Setting(container)
    .setName("规划师")
    .addDropdown((dropdown) => {
      for (const value of REASONING_VALUES) dropdown.addOption(value, EFFORT_LABELS[value]);
      dropdown.setValue(settings.reasoning.planner);
      dropdown.onChange(async (value) => {
        await host.commit({
          reasoning: { ...host.getSettings().reasoning, planner: value as ReasoningEffort },
        });
      });
    });

  new Setting(container)
    .setName("导师")
    .addDropdown((dropdown) => {
      for (const value of REASONING_VALUES) dropdown.addOption(value, EFFORT_LABELS[value]);
      dropdown.setValue(settings.reasoning.tutor);
      dropdown.onChange(async (value) => {
        await host.commit({
          reasoning: { ...host.getSettings().reasoning, tutor: value as ReasoningEffort },
        });
      });
    });

  // ---- 高级（少改的） ----
  container.createEl("h4", { text: "高级" });

  new Setting(container)
    .setName("thinking 字段形态")
    .setDesc("自动判断即可；某些兼容服务两个字段都不认时选「不发送」。")
    .addDropdown((dropdown) => {
      for (const [value, label] of Object.entries(THINKING_FORMAT_LABELS)) {
        dropdown.addOption(value, label);
      }
      dropdown.setValue(settings.thinkingFormat);
      dropdown.onChange(async (value) => {
        await host.commit({ thinkingFormat: value as ThinkingFormat });
      });
    });

  new Setting(container)
    .setName("最大输出 tokens")
    .setDesc("默认 32768。开启 thinking 的模型给小了会「不说话」。")
    .addText((text) => {
      text.inputEl.type = "number";
      text.setValue(String(settings.maxOutputTokens));
      text.onChange(async (value) => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return;
        await host.commit({ maxOutputTokens: Math.max(1024, Math.floor(parsed)) });
      });
    });
}

function showNewFolderInput(container: HTMLElement, host: SettingsFormHost): void {
  let draft = "";
  new Setting(container)
    .setName("新建目录")
    .setDesc("可以写多级，如 学习/Rust。")
    .addText((text) => {
      text.setPlaceholder("学习Agent");
      text.onChange((value) => {
        draft = value.trim();
      });
    })
    .addButton((button) => {
      button.setButtonText("创建").setCta().onClick(async () => {
        const name = draft.trim();
        if (!name) {
          new Notice("目录名不能为空");
          return;
        }
        await ensureFolder(host.app, name);
        await host.commit({ notesFolder: name });
        new Notice(`工作目录已设为「${name}」`);
        host.rerender();
      });
    });
}
