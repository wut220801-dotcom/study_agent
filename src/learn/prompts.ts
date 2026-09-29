/**
 * 提示词加载。
 *
 * 提示词放在独立的 .md 文件而不是代码里的模板字符串，因为提示词的迭代频率远高于
 * 代码：改措辞、调语气、加约束，这些操作不应该有碰坏代码的风险，diff 也应该干净。
 *
 * 注意：这依赖运行时能从源码目录读到文件，所以服务必须用 tsx 从 src/ 启动。
 * 若将来要编译成 dist，需要把 prompts/ 一起拷贝过去。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cache = new Map<string, string>();

/**
 * 提示词目录，惰性求值。
 *
 * 不能在模块顶层算 `import.meta.url`：插件是 CJS 打包产物，import.meta 是空的，
 * 顶层求值会直接把模块加载搞崩。而插件走的是下面的注入路径，根本不需要这个目录，
 * 所以延迟到真正要读文件时再算。
 */
function promptsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "prompts");
}

/**
 * 提示词覆盖。
 *
 * 存在的理由:Obsidian 插件是打包产物,运行时没有「源码目录」这回事，
 * `import.meta.url` 指不到 .md 文件。所以插件在启动时把 .md 作为字符串注入进来
 * （esbuild 的 text loader），这里优先用注入值、否则回退到读文件。
 * 服务端走读文件那条路，插件走注入那条，两边共用同一批提示词文件。
 */
const overrides = new Map<string, string>();

export function setPromptOverrides(next: Record<string, string>): void {
  for (const [name, text] of Object.entries(next)) {
    overrides.set(name, text.trim());
  }
}

export function loadPrompt(name: string): string {
  const injected = overrides.get(name);
  if (injected !== undefined) return injected;

  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const text = readFileSync(join(promptsDir(), `${name}.md`), "utf8").trim();
  cache.set(name, text);
  return text;
}
