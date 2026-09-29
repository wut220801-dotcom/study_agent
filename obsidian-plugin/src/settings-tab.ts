/**
 * Obsidian 设置页里的入口。
 *
 * 表单本身在 settings-form.ts —— 面板里也渲染同一份，避免两套控件各自演化。
 * 这里只负责把它挂到设置页的容器上。
 */

import { PluginSettingTab, type App } from "obsidian";

import type LearnAgentPlugin from "./main.js";
import { renderSettingsForm } from "./settings-form.js";

export class LearnAgentSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: LearnAgentPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h3", { text: "Learn Agent" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "这些设置在面板右上角的齿轮里也能改。",
    });

    renderSettingsForm(containerEl, {
      app: this.app,
      getSettings: () => this.plugin.settings,
      commit: (next) => this.plugin.updateSettings(next),
      rerender: () => this.display(),
    });
  }
}
