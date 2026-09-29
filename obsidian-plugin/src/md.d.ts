/**
 * esbuild 的 text loader 让 .md 导入变成字符串。
 * TypeScript 不知道这件事，所以要声明一下。
 */
declare module "*.md" {
  const content: string;
  export default content;
}
