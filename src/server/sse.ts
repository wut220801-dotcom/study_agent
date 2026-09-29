/**
 * SSE 流式推送。
 *
 * 一轮对话的过程需要实时可见——文本一个字一个字出来、工具调用被展示、出错能看见。
 * 这里刻意用 SSE 而不是 WebSocket：交互是「发一条消息，收一串事件」的请求-响应模型，
 * 不需要双向长连接；而且 SSE 可以直接用 curl 调试，排查问题省一半时间。
 */

import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { LoopEvent, LoopResult } from "../core/loop.js";

/** 一轮结束的摘要。error 必须回传——它可能是「达到轮次上限」这类用户需要知道的信息。 */
export interface TurnSummary {
  stopReason: string;
  iterations: number;
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  error?: string;
  cached?: boolean;
}

function projectResult(result: LoopResult | { cached: boolean }): TurnSummary {
  if ("cached" in result && !("stopReason" in result)) {
    return { stopReason: "stop", iterations: 0, usage: { input: 0, output: 0 }, cached: result.cached };
  }
  const loop = result as LoopResult;
  return {
    stopReason: loop.stopReason,
    iterations: loop.iterations,
    usage: loop.usage,
    ...(loop.error ? { error: loop.error } : {}),
  };
}

export function turnStream(
  c: Context,
  run: (emit: (event: LoopEvent) => Promise<void>) => Promise<LoopResult | { cached: boolean }>,
) {
  return streamSSE(c, async (stream) => {
    // 客户端断开后继续写会抛错，用这个标志安静退出
    let closed = false;
    stream.onAbort(() => {
      closed = true;
    });

    const emit = async (event: LoopEvent): Promise<void> => {
      if (closed) return;
      try {
        await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
      } catch {
        closed = true;
      }
    };

    try {
      const result = await run(emit);
      if (!closed) {
        // 只回传摘要，不回传 messages——客户端会重新拉取会话条目，
        // 把整轮消息再塞进事件里是重复传输。
        await stream.writeSSE({ event: "result", data: JSON.stringify(projectResult(result)) });
      }
    } catch (error) {
      if (!closed) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: error instanceof Error ? error.message : String(error) }),
        });
      }
    }
  });
}
