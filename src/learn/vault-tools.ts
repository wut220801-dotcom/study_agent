/**
 * 笔记库相关的工具，供各类角色复用。
 *
 * 抽成共享模块的原因：这三类角色都需要「看学习者的笔记」，但工具表本来各自写在
 * planner.ts / tutor.ts 里。不抽出来的话，新增角色时就得再抄一遍。
 *
 * 设计原则和别处一致：**容量必须有上限**。给 agent 一个「把整个库读进来」的工具，
 * 等于给它一个把自己上下文淹掉的开关。看结构、按需读单篇，才是正确的粒度。
 */

import { objectSchema, stringParam, type Tool } from "../core/tools/types.js";
import type { VaultAccess } from "./vault-access.js";

/** 所有带库访问能力的工具上下文都至少要能满足这两点。 */
export interface VaultToolContext {
  vault?: VaultAccess;
  /** 列结构时的默认起点。规划师用工作目录，其他角色用库根。 */
  workFolder?: string;
}

export const listVaultStructureTool: Tool<VaultToolContext> = {
  name: "list_vault_structure",
  description:
    "查看笔记库的目录结构（只有文件夹和笔记名，不含内容）。" +
    "用来了解已经积累了哪些领域、笔记是怎么组织的。" +
    '不传 path 时列出工作目录，传空字符串 "" 列出库根，也可以传具体子目录。',
  parameters: objectSchema(
    {
      path: stringParam(
        '相对库根的目录路径。省略 = 工作目录；"" = 库根；也可以写 "安卓逆向" 这样的子目录',
      ),
    },
    [],
  ),
  async execute(args, ctx) {
    if (!ctx.vault) return "当前环境看不到笔记库。";
    const path =
      args.path === undefined ? (ctx.workFolder ?? "") : String(args.path).trim();
    return ctx.vault.describe(path, 200);
  },
};

export const readVaultNoteTool: Tool<VaultToolContext> = {
  name: "read_vault_note",
  description:
    "读某一篇笔记的内容。用在你确实需要知道某篇写了什么的时候，不要用它通读整个库。" +
    "路径要带 .md 后缀。",
  parameters: objectSchema(
    {
      path: stringParam('相对库根的路径，例如 "安卓逆向/Android开发基础/01-创建一个安卓程序.md"'),
    },
    ["path"],
  ),
  async execute(args, ctx) {
    if (!ctx.vault) return "当前环境看不到笔记库。";
    const path = String(args.path ?? "").trim();
    if (!path) return "path 不能为空。";
    return ctx.vault.read(path, 6000);
  },
};

/** 一个更省 context 的变体：只列顶层，适合教学场景快速看一眼。 */
export const listLearnerNotesTool: Tool<VaultToolContext> = {
  name: "list_learner_notes",
  description:
    "快速查看笔记库的目录结构（只有名字，不含内容），用来了解学习者在相关领域已经记过什么。" +
    "讲课前想知道「他之前有没有碰过这个」时可以调用。",
  parameters: objectSchema(
    {
      path: stringParam("相对库根的目录路径，省略 = 库根"),
    },
    [],
  ),
  async execute(args, ctx) {
    if (!ctx.vault) return "当前环境看不到笔记库。";
    const path = args.path === undefined ? "" : String(args.path).trim();
    return ctx.vault.describe(path, 120);
  },
};
