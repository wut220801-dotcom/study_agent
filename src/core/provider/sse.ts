/**
 * Server-Sent Events 解析。
 *
 * Anthropic 和 OpenAI 的流式接口都是 SSE，但两者的 JSON 结构完全不同，
 * 所以把「按 SSE 分帧」这一层单独抽出来，两个 provider 各自解析负载。
 */

export interface SSEFrame {
  event?: string;
  data: string;
}

/**
 * 把 fetch 的响应体解析成一个个 SSE 帧。
 *
 * 两个容易写错的地方：
 * 1. 行尾可能是 \n 或 \r\n，块之间可能是 \n\n 或 \r\n\r\n —— 先归一化再切分。
 * 2. 网络分片不保证落在帧边界上，必须用一个跨 chunk 的缓冲区累积。
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEFrame, void, undefined> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const frame = parseFrame(raw);
      if (frame) yield frame;
      boundary = buffer.indexOf("\n\n");
    }
  }

  // 流结束时缓冲区里可能还有最后一帧（没有以空行收尾）
  const tail = parseFrame(buffer);
  if (tail) yield tail;
}

function parseFrame(raw: string): SSEFrame | null {
  let event: string | undefined;
  const dataLines: string[] = [];

  for (const line of raw.split("\n")) {
    if (line === "" || line.startsWith(":")) continue; // 空行与注释（keep-alive 心跳）

    const colon = line.indexOf(":");
    // 没有冒号的行整行都是字段名，值为空串
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1); // 规范要求剥掉一个前导空格

    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}
