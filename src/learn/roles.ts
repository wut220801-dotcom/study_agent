/**
 * 自定义对话角色。
 *
 * 最初的版本只有两个硬编码角色：规划师（管大纲）和导师（管一个知识点）。
 * 但「学习」不只有「按大纲推进」这一种用法——很多时候你只是想对当前正在读的
 * 一篇笔记做点什么：总结一下、梳理成清单、换个角度讲讲。这类需求不需要大纲，
 * 也不该硬塞进规划师或某个导师的会话里。
 *
 * 所以角色变成了**数据**：一个名字、一段系统提示、要不要自动带上当前笔记。
 * 用户想加几个就加几个，每个有自己独立的会话。内置的规划师和导师走另一条路
 * （它们的提示词和工具是专门设计的），但也在这个模型里占一格。
 */

export interface CustomRole {
  id: string;
  /** 显示名，会出现在左栏 */
  name: string;
  /** lucide 图标名，如 "file-text" "list" "languages" */
  icon?: string;
  /** 这个角色的系统提示。写清楚它是干什么的、该怎么回应。 */
  systemPrompt: string;
  /**
   * 是否在每轮自动把「当前打开的笔记」附在消息前面。
   *
   * 这是「总结当前内容」这类角色能好用的关键：不用先复制粘贴再描述「我在看哪篇」，
   * 它本来就知道。
   */
  attachActiveNote?: boolean;
  /** 是否给这个角色读笔记库的能力（结构 + 按需读单篇） */
  vaultAccess?: boolean;
}

/** 自定义角色会话的 id。带前缀避免跟 planner / tutor-* 撞名。 */
export function customRoleSessionId(roleId: string): string {
  return `role-${roleId}`;
}

/** 生成一个稳定的角色 id。用时间戳 + 随机后缀，避免重名。 */
export function newRoleId(): string {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 组装自定义角色的系统提示。
 *
 * 只做三件事：给身份、交代当前工作目录、说明手上有哪些工具。剩下的行为约束
 * 由用户自己写的那段提示负责——这是刻意的，不同角色的行为差异应该体现在
 * 用户可控的那段文字里，而不是我在这里预设。
 */
export function buildCustomRolePrompt(role: CustomRole, workFolder: string): string {
  const lines = [
    role.systemPrompt.trim(),
    "",
    "---",
    "",
    "# 工作环境",
    "",
    `你运行在学习者的 Obsidian 笔记库里。他的学习资料放在「${workFolder}」目录下。`,
  ];

  if (role.attachActiveNote) {
    lines.push(
      "",
      "每轮对话我会把**他当前打开的笔记内容**附在消息里。他可以直接说「总结一下」" +
        "「这段什么意思」而不用先告诉你他在看什么——你已经在消息里看到了。",
    );
  }

  if (role.vaultAccess) {
    lines.push(
      "",
      "你可以用 list_vault_structure 看笔记库的目录结构，用 read_vault_note 读具体某一篇。",
      "看结构就够了，不要通读整个库——那会把你的上下文淹掉，反而做不好手上这件事。",
    );
  }

  lines.push(
    "",
    "# 输出要求",
    "",
    "直接用 markdown 回答。这是 Obsidian，所以你写的 [[双链]] 是可点击的——" +
      "提到库里的某篇笔记时可以用双链指过去。",
  );

  return lines.join("\n");
}
