import type { ProviderPreset } from "@codexdeck/shared";

export interface ProviderPresetDefinition {
  id: ProviderPreset;
  label: string;
  defaultBaseUrl: string | null;
  authHeader: string;
}

export const providerPresets: Record<ProviderPreset, ProviderPresetDefinition> = {
  openai_official: {
    id: "openai_official",
    label: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    authHeader: "Authorization",
  },
  oneapi_newapi: {
    id: "oneapi_newapi",
    label: "OneAPI / New API",
    defaultBaseUrl: null,
    authHeader: "Authorization",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    authHeader: "Authorization",
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    authHeader: "Authorization",
  },
  ollama: {
    id: "ollama",
    label: "Ollama",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    authHeader: "Authorization",
  },
  custom: {
    id: "custom",
    label: "Custom OpenAI-compatible API",
    defaultBaseUrl: null,
    authHeader: "Authorization",
  },
};
