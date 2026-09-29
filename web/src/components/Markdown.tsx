import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * markdown 渲染。
 *
 * 导师的输出天然是 markdown（讲解会用标题、列表、代码块），所以这里不是可选项。
 * 样式在 index.css 的 .prose-learn 里，用 currentColor 的 color-mix 做底色，
 * 这样在深色/浅色两种主题下都不用维护两套颜色。
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose-learn">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
