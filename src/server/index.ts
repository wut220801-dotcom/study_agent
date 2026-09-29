/**
 * 服务入口。
 *
 * 开发时前端由 Vite 跑在另一个端口并代理 /api 过来；生产模式下这里直接托管
 * web/dist 的构建产物，一个进程搞定。
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

import { loadConfig } from "../config.js";
import { LearningRuntime } from "../learn/runtime.js";
import { createApi } from "./api.js";
import { createSettingsApi } from "./settings-api.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const config = loadConfig(projectRoot);
const runtime = new LearningRuntime(config);

const app = new Hono();
app.route("/api", createApi(runtime));
// 设置接口挂在 /api/settings 下，与业务接口分开：
// 它改的是运行时行为而且涉及密钥，单独一个文件更容易审查
app.route("/api/settings", createSettingsApi(runtime));

const webDist = join(projectRoot, "web", "dist");
if (existsSync(webDist)) {
  app.use("/*", serveStatic({ root: "web/dist" }));
  // 前端路由回退：非 /api 的路径都交给 index.html
  app.get("*", serveStatic({ path: "web/dist/index.html" }));
} else {
  app.get("/", (c) =>
    c.text(
      "前端还没有构建。开发时请另开一个终端运行 `npm --prefix web run dev`，\n" +
        "或先执行 `npm --prefix web run build` 让本进程托管构建产物。",
    ),
  );
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  const base = `http://127.0.0.1:${info.port}`;
  console.log(`\n学习 agent 已启动`);
  console.log(`  地址：      ${base}`);
  console.log(`  模型：      ${config.provider.model}（${config.provider.kind}）`);
  console.log(`  上下文窗口：${config.contextWindow.toLocaleString()} tokens`);
  console.log(`  数据目录：  ${config.workspaceRoot}`);
  console.log(`\n工作目录里的每个知识点都会是一条独立的会话，学习细节不会进入规划师的上下文。\n`);
});
