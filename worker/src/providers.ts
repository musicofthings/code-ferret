/**
 * CodeFerret multi-provider LLM layer.
 * Dispatches review/report completions to any supported frontier-model
 * provider (Anthropic Claude, OpenAI GPT/Codex, Google Gemini, xAI Grok).
 * Model IDs and endpoints come from the repo-root models.json registry,
 * which is refreshed weekly by scripts/check_models.py.
 */

import registry from "../../models.json";

export type ProviderId = "anthropic" | "openai" | "google" | "xai";

export interface ProviderEnv {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  GOOGLE_API_KEY?: string;
  XAI_API_KEY?: string;
  /** Optional deploy-time overrides (wrangler vars). */
  CODEFERRET_PROVIDER?: string;
  CODEFERRET_MODEL?: string;
}

export interface CompletionRequest {
  system: string;
  user: string;
  maxTokens: number;
}

interface ProviderSpec {
  display_name: string;
  api_kind: string;
  endpoint: string;
  models_endpoint: string;
  key_env: string[];
  default_model: string;
  fallback_models: string[];
}

const PROVIDERS = registry.providers as unknown as Record<ProviderId, ProviderSpec>;
const PROVIDER_ORDER = registry.default_provider_order as ProviderId[];

export function providerApiKey(env: ProviderEnv, provider: ProviderId): string | undefined {
  for (const name of PROVIDERS[provider].key_env) {
    const value = (env as Record<string, string | undefined>)[name];
    if (value) return value;
  }
  return undefined;
}

export function resolveProvider(env: ProviderEnv): ProviderId {
  if (env.CODEFERRET_PROVIDER) {
    const requested = env.CODEFERRET_PROVIDER as ProviderId;
    if (!PROVIDERS[requested]) {
      throw new Error(
        `CODEFERRET_PROVIDER "${env.CODEFERRET_PROVIDER}" is not supported; use one of: ${PROVIDER_ORDER.join(", ")}`,
      );
    }
    if (!providerApiKey(env, requested)) {
      throw new Error(
        `CODEFERRET_PROVIDER is "${requested}" but none of its API keys (${PROVIDERS[requested].key_env.join(", ")}) are configured`,
      );
    }
    return requested;
  }
  for (const provider of PROVIDER_ORDER) {
    if (providerApiKey(env, provider)) return provider;
  }
  throw new Error(
    "No LLM provider API key configured. Set one of: " +
      PROVIDER_ORDER.map((provider) => PROVIDERS[provider].key_env[0]).join(", "),
  );
}

export function resolveModel(env: ProviderEnv, provider: ProviderId): string {
  return env.CODEFERRET_MODEL || PROVIDERS[provider].default_model;
}

async function requireModelResponse(response: Response, displayName: string): Promise<any> {
  if (!response.ok) throw new Error(`${displayName} API returned ${response.status}`);
  return response.json();
}

async function anthropicCompletion(
  spec: ProviderSpec,
  apiKey: string,
  model: string,
  request: CompletionRequest,
): Promise<string> {
  const response = await fetch(spec.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: [{ role: "user", content: request.user }],
    }),
  });
  const data = await requireModelResponse(response, spec.display_name);
  const blocks: any[] = Array.isArray(data.content) ? data.content : [];
  return blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

async function openAiResponsesCompletion(
  spec: ProviderSpec,
  apiKey: string,
  model: string,
  request: CompletionRequest,
): Promise<string> {
  const response = await fetch(spec.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_output_tokens: request.maxTokens,
      instructions: request.system,
      input: request.user,
    }),
  });
  const data = await requireModelResponse(response, spec.display_name);
  if (typeof data.output_text === "string") return data.output_text;
  const output: any[] = Array.isArray(data.output) ? data.output : [];
  return output
    .filter((item) => item?.type === "message" && Array.isArray(item.content))
    .flatMap((item) => item.content)
    .filter((part: any) => part?.type === "output_text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("");
}

async function geminiCompletion(
  spec: ProviderSpec,
  apiKey: string,
  model: string,
  request: CompletionRequest,
): Promise<string> {
  const response = await fetch(spec.endpoint.replace("{model}", encodeURIComponent(model)), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: "user", parts: [{ text: request.user }] }],
      generationConfig: { maxOutputTokens: request.maxTokens },
    }),
  });
  const data = await requireModelResponse(response, spec.display_name);
  const parts: any[] = data.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((part) => typeof part?.text === "string")
    .map((part) => part.text)
    .join("");
}

async function chatCompletionsCompletion(
  spec: ProviderSpec,
  apiKey: string,
  model: string,
  request: CompletionRequest,
): Promise<string> {
  const response = await fetch(spec.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: request.maxTokens,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
    }),
  });
  const data = await requireModelResponse(response, spec.display_name);
  const content = data.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

export async function runCompletion(env: ProviderEnv, request: CompletionRequest): Promise<string> {
  const provider = resolveProvider(env);
  const spec = PROVIDERS[provider];
  const apiKey = providerApiKey(env, provider);
  if (!apiKey) throw new Error(`${spec.display_name} API key is not configured`);
  const model = resolveModel(env, provider);

  switch (spec.api_kind) {
    case "anthropic-messages":
      return anthropicCompletion(spec, apiKey, model, request);
    case "openai-responses":
      return openAiResponsesCompletion(spec, apiKey, model, request);
    case "gemini-generate-content":
      return geminiCompletion(spec, apiKey, model, request);
    case "openai-chat-completions":
      return chatCompletionsCompletion(spec, apiKey, model, request);
    default:
      throw new Error(`Unsupported api_kind "${spec.api_kind}" for provider ${provider}`);
  }
}
