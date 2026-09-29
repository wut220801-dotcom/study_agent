/**
 * esbuild 配置。
 *
 * 三个关键点：
 * - `obsidian` 和 `electron` 必须 external：它们是 Obsidian 运行时才提供的，
 *   打进来会炸。
 * - `.md` 用 text loader 打进去：插件运行时没有「源码目录」，提示词必须以字符串
 *   形式进入产物（见 src/learn/prompts.ts 的注入接缝）。
 * - 产物是 CommonJS 的 main.js：Obsidian 的插件加载器要求如此。
 */

import esbuild from "esbuild";
import process from "node:process";

const watch = process.argv.includes("--watch");

/** 指向主项目的 src/，插件的 agent 逻辑直接复用那边，不复制代码。 */
const shared = "../src";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  outfile: "main.js",
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "es2022",
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
  // 提示词全是中文。不设这个的话 esbuild 会把每个汉字转义成 \uXXXX，
  // 产物体积膨胀不说，出问题时在 main.js 里根本没法读。
  charset: "utf8",
  external: ["obsidian", "electron"],
  loader: { ".md": "text" },
  // 让插件能直接 import 主项目的 core/ 与 learn/
  alias: { "@shared": shared },
});

if (watch) {
  await context.watch();
  console.log("watching…");
} else {
  await context.rebuild();
  await context.dispose();
}
