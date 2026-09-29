/**
 * 库访问接缝。
 *
 * 学习层不能直接读用户的 Obsidian 库——它连 `obsidian` 模块都不认识。所以这里定义
 * 一个窄接口，由宿主注入实现：插件用 `app.vault` 提供，服务端模式不提供（那时
 * agent 没有库可看，相关工具也不注册）。
 *
 * 接口刻意只有两个方法，而且都**带容量上限**。这不是为了省事，是因为规划师的
 * 上下文必须保持干净：给它一个「把整个库读进来」的工具，等于给了它一个把自己
 * 淹没的开关。看结构、按需读单篇，才是「了解你的笔记怎么组织」的正确粒度。
 */

export interface VaultAccess {
  /**
   * 描述目录结构（只有名字，不含内容）。
   *
   * @param path 相对库根的路径；空串表示库根
   * @param maxEntries 最多返回多少条，超出会截断并注明
   */
  describe(path: string, maxEntries: number): Promise<string>;

  /**
   * 读一篇笔记的内容。
   *
   * @param path 相对库根的路径，含 .md 后缀
   * @param maxChars 内容上限，超出截断
   */
  read(path: string, maxChars: number): Promise<string>;
}
