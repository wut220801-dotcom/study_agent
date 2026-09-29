/**
 * 会话存储：append-only 的条目树。
 *
 * 为什么是树而不是数组：条目带 parentId，会话用一个 leafId 游标记住「当前在哪」。
 * 于是「撤销一次注入」「重试这一轮」都退化成移动游标，不需要删除或改写任何历史。
 * 这对学习场景很关键——注错了前置知识会持续污染导师的判断，必须能干净地撤掉。
 *
 * 压缩（compaction）条目把 retainedTail 内联存进自己，因此是**自包含的检查点**：
 * 上下文构建遇到它就从它开始，永远不读它之前的条目。这样压缩链不会退化成
 * 「回溯多个检查点」的复杂逻辑。
 */

import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { assistantText, type Message } from "./types.js";

export interface EntryBase {
  id: string;
  parentId: string | null;
  /** 毫秒时间戳 */
  ts: number;
}

export interface MessageEntry extends EntryBase {
  type: "message";
  message: Message;
}

export interface CompactionEntry extends EntryBase {
  type: "compaction";
  summary: string;
  /** 压缩边界之后保留的原始消息。内联存放，使本条目自包含。 */
  retainedTail: Message[];
  tokensBefore: number;
}

/**
 * 扩展条目。core 不认识它的语义，只负责存取；是否进入模型上下文由 inContext 决定，
 * 渲染方式由使用方通过 renderCustom 提供。
 *
 * 学习层用两种 customType：
 *   - injected_knowledge：别处压缩来的前置知识，inContext = true
 *   - report：上报给规划师的进度报告，inContext = false（导师自己知道报过什么，
 *     不需要把报告再读一遍；它只给规划师和 UI 看）
 */
export interface CustomEntry extends EntryBase {
  type: "custom";
  customType: string;
  data: Record<string, unknown>;
  inContext: boolean;
}

export type Entry = MessageEntry | CompactionEntry | CustomEntry;

export const COMPACTION_PREFIX =
  "以下是此前对话被压缩后的摘要，作为已确立的背景使用，不要复述：\n\n<summary>\n";
export const COMPACTION_SUFFIX = "\n</summary>";

export interface SessionOptions {
  id: string;
  filePath: string;
  /** 把 custom 条目渲染成模型可读的消息。返回 null 表示不进上下文。 */
  renderCustom?: (entry: CustomEntry) => Message | null;
}

export class Session {
  private entries: Entry[] = [];
  private leafId: string | null = null;
  private readonly byId = new Map<string, Entry>();

  constructor(private readonly options: SessionOptions) {}

  get id(): string {
    return this.options.id;
  }

  get currentLeafId(): string | null {
    return this.leafId;
  }

  /** 当前分支（root → leaf，按时间顺序）。历史条目在树里仍可达，只是不在当前分支上。 */
  branch(): Entry[] {
    const path: Entry[] = [];
    let cursor = this.leafId;
    while (cursor) {
      const entry = this.byId.get(cursor);
      if (!entry) break;
      path.push(entry);
      cursor = entry.parentId;
    }
    return path.reverse();
  }

  appendMessage(message: Message): MessageEntry {
    return this.appendEntry({ ...this.entryBase(), type: "message", message });
  }

  appendCustom(
    customType: string,
    data: Record<string, unknown>,
    inContext: boolean,
  ): CustomEntry {
    return this.appendEntry({ ...this.entryBase(), type: "custom", customType, data, inContext });
  }

  appendCompaction(
    summary: string,
    retainedTail: Message[],
    tokensBefore: number,
  ): CompactionEntry {
    return this.appendEntry({
      ...this.entryBase(),
      type: "compaction",
      summary,
      retainedTail,
      tokensBefore,
    });
  }

  /** 追加前先取一次基字段——leafId 会在 appendEntry 里被改写。 */
  private entryBase(): EntryBase {
    return { id: randomUUID(), parentId: this.leafId, ts: Date.now() };
  }

  private appendEntry<T extends Entry>(entry: T): T {
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
    this.persist(entry);
    return entry;
  }

  /**
   * 移动游标。用来撤销注入或重试某一轮——被跳过的条目留在文件里，
   * 只是不再出现在当前分支上。
   */
  navigateTo(entryId: string | null): void {
    if (entryId !== null && !this.byId.has(entryId)) {
      throw new Error(`entry not found: ${entryId}`);
    }
    this.leafId = entryId;
    this.persistLeaf();
  }

  /** 构建交给模型的消息列表。 */
  buildContext(): Message[] {
    const path = this.branch();

    // 最后一个压缩条目是上下文窗口的起点，它之前的条目一律不读
    let startIndex = -1;
    for (let i = path.length - 1; i >= 0; i--) {
      if (path[i]!.type === "compaction") {
        startIndex = i;
        break;
      }
    }

    const messages: Message[] = [];
    for (let i = startIndex === -1 ? 0 : startIndex; i < path.length; i++) {
      messages.push(...this.project(path[i]!));
    }
    return messages;
  }

  private project(entry: Entry): Message[] {
    switch (entry.type) {
      case "message":
        return [entry.message];
      case "compaction":
        return [assistantText(COMPACTION_PREFIX + entry.summary + COMPACTION_SUFFIX),
                ...entry.retainedTail];
      case "custom": {
        if (!entry.inContext) return [];
        const rendered = this.options.renderCustom?.(entry);
        return rendered ? [rendered] : [];
      }
    }
  }

  /** 最近的压缩条目，供压缩触发逻辑判断边界。 */
  latestCompaction(): CompactionEntry | null {
    const path = this.branch();
    for (let i = path.length - 1; i >= 0; i--) {
      const entry = path[i]!;
      if (entry.type === "compaction") return entry;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // 持久化：JSONL，追加写。每条 append 立刻落盘，崩溃时已产生的学习内容不丢。
  // -------------------------------------------------------------------------

  private persist(entry: Entry): void {
    mkdirSync(dirname(this.options.filePath), { recursive: true });
    appendFileSync(this.options.filePath, `${JSON.stringify(entry)}\n`, "utf8");
  }

  private persistLeaf(): void {
    mkdirSync(dirname(this.options.filePath), { recursive: true });
    appendFileSync(
      this.options.filePath,
      `${JSON.stringify({ type: "_leaf", leafId: this.leafId, ts: Date.now() })}\n`,
      "utf8",
    );
  }

  static load(options: SessionOptions): Session {
    const session = new Session(options);
    if (!existsSync(options.filePath)) return session;

    const raw = readFileSync(options.filePath, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // 写入中断产生的半截行，跳过即可
      }

      if (parsed.type === "_leaf") {
        session.leafId = parsed.leafId ?? null;
        continue;
      }
      if (typeof parsed.id !== "string") continue;

      const entry = parsed as Entry;
      session.entries.push(entry);
      session.byId.set(entry.id, entry);
      // 追加行的父子关系天然构成当前分支，这里跟着推进游标
      if (session.leafId === null || entry.parentId === session.leafId) {
        session.leafId = entry.id;
      }
    }

    return session;
  }
}
