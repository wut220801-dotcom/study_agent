/**
 * Provider 工厂。
 */

import type { Provider, ProviderConfig } from "./types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { MockProvider } from "./mock.js";

export function anthropicProvider(config: ProviderConfig): Provider {
  return new AnthropicProvider(config);
}

export function openaiProvider(config: ProviderConfig): Provider {
  return new OpenAIProvider(config);
}

export function createProvider(config: ProviderConfig): Provider {
  switch (config.kind) {
    case "anthropic":
      return anthropicProvider(config);
    case "openai":
      return openaiProvider(config);
    case "mock":
      return new MockProvider(config.model);
  }
}

export { AnthropicProvider, OpenAIProvider, MockProvider };
export type { Provider, ProviderConfig };
