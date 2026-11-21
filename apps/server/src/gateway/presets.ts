import type { ProviderPreset } from "@codexdeck/shared";

export interface ProviderPresetDefinition {
  id: ProviderPreset;
  label: string;
  defaultBaseUrl: string | null;
  authHeader: string;
  protocol_type?: "openai_responses"|"openai_chat"|"anthropic_messages"|"gemini_openai";
  patch_rules?:{developer_to_system?:boolean;map_max_tokens?:boolean};
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
  anthropic: {id:"anthropic",label:"Anthropic", defaultBaseUrl:"https://api.anthropic.com/v1",protocol_type:"anthropic_messages",authHeader:"x-api-key"},
  gemini: {id:"gemini",label:"Google Gemini", defaultBaseUrl:"https://generativelanguage.googleapis.com/v1beta/openai",protocol_type:"gemini_openai",authHeader:"Authorization"},
  siliconflow: {id:"siliconflow",label:"硅基流动", defaultBaseUrl:"https://api.siliconflow.cn/v1",protocol_type:"openai_chat",authHeader:"Authorization",patch_rules:{map_max_tokens:true}},
  volcengine: {id:"volcengine",label:"火山方舟", defaultBaseUrl:"https://ark.cn-beijing.volces.com/api/v3",protocol_type:"openai_chat",authHeader:"Authorization",patch_rules:{map_max_tokens:true}},
  dashscope: {id:"dashscope",label:"阿里云百炼", defaultBaseUrl:"https://dashscope.aliyuncs.com/compatible-mode/v1",protocol_type:"openai_chat",authHeader:"Authorization",patch_rules:{map_max_tokens:true}},
  kimi: {id:"kimi",label:"月之暗面 Kimi", defaultBaseUrl:"https://api.moonshot.cn/v1",protocol_type:"openai_chat",authHeader:"Authorization",patch_rules:{map_max_tokens:true}},
  zhipu: {id:"zhipu",label:"智谱", defaultBaseUrl:"https://open.bigmodel.cn/api/paas/v4",protocol_type:"openai_chat",authHeader:"Authorization",patch_rules:{map_max_tokens:true}},
  groq: {id:"groq",label:"Groq", defaultBaseUrl:"https://api.groq.com/openai/v1",protocol_type:"openai_chat",authHeader:"Authorization",patch_rules:{map_max_tokens:true}},
  together: {id:"together",label:"Together AI", defaultBaseUrl:"https://api.together.xyz/v1",protocol_type:"openai_chat",authHeader:"Authorization",patch_rules:{map_max_tokens:true}},
  lm_studio: {id:"lm_studio",label:"LM Studio", defaultBaseUrl:"http://127.0.0.1:1234/v1",protocol_type:"openai_chat",authHeader:"Authorization",patch_rules:{map_max_tokens:true}},
  vllm: {id:"vllm",label:"vLLM", defaultBaseUrl:"http://127.0.0.1:8000/v1",protocol_type:"openai_chat",authHeader:"Authorization",patch_rules:{map_max_tokens:true}},
  custom: {
    id: "custom",
    label: "Custom OpenAI-compatible API",
    defaultBaseUrl: null,
    authHeader: "Authorization",
  },
};
