import { afterEach, describe, expect, it, vi } from "vitest";
import {
  providerApiKey,
  resolveModel,
  resolveProvider,
  runCompletion,
  type ProviderEnv,
} from "./providers";

const REQUEST = { system: "system prompt", user: "user prompt", maxTokens: 1024 };

function mockFetch(payload: unknown, status = 200) {
  const fetchMock = vi.fn(
    async (_input: string, _init?: RequestInit) => new Response(JSON.stringify(payload), { status }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>): any {
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  return JSON.parse(String(init.body));
}

function requestHeaders(fetchMock: ReturnType<typeof vi.fn>): Record<string, string> {
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  return init.headers as Record<string, string>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider resolution", () => {
  it("selects the first provider with a configured key, in registry order", () => {
    expect(resolveProvider({ ANTHROPIC_API_KEY: "a", XAI_API_KEY: "x" })).toBe("anthropic");
    expect(resolveProvider({ OPENAI_API_KEY: "o" })).toBe("openai");
    expect(resolveProvider({ GEMINI_API_KEY: "g" })).toBe("google");
    expect(resolveProvider({ GOOGLE_API_KEY: "g" })).toBe("google");
    expect(resolveProvider({ XAI_API_KEY: "x" })).toBe("xai");
  });

  it("honors an explicit CODEFERRET_PROVIDER override", () => {
    const env: ProviderEnv = {
      ANTHROPIC_API_KEY: "a",
      XAI_API_KEY: "x",
      CODEFERRET_PROVIDER: "xai",
    };
    expect(resolveProvider(env)).toBe("xai");
  });

  it("rejects unknown providers, missing keys, and empty configuration", () => {
    expect(() => resolveProvider({ CODEFERRET_PROVIDER: "skynet", XAI_API_KEY: "x" })).toThrow(
      "not supported",
    );
    expect(() => resolveProvider({ CODEFERRET_PROVIDER: "openai", XAI_API_KEY: "x" })).toThrow(
      "OPENAI_API_KEY",
    );
    expect(() => resolveProvider({})).toThrow("No LLM provider API key configured");
  });

  it("uses the registry default model unless CODEFERRET_MODEL overrides it", () => {
    expect(resolveModel({}, "anthropic")).toBe("claude-sonnet-5");
    expect(resolveModel({}, "openai")).toBe("gpt-5.6-terra");
    expect(resolveModel({}, "google")).toBe("gemini-3.6-flash");
    expect(resolveModel({}, "xai")).toBe("grok-4.5");
    expect(resolveModel({ CODEFERRET_MODEL: "claude-opus-5" }, "anthropic")).toBe("claude-opus-5");
  });

  it("reads keys from any registered env var name", () => {
    expect(providerApiKey({ GEMINI_API_KEY: "g1" }, "google")).toBe("g1");
    expect(providerApiKey({ GOOGLE_API_KEY: "g2" }, "google")).toBe("g2");
    expect(providerApiKey({}, "google")).toBeUndefined();
  });
});

describe("provider request/response shapes", () => {
  it("calls the Anthropic Messages API and joins text blocks", async () => {
    const fetchMock = mockFetch({
      content: [
        { type: "text", text: "[]" },
        { type: "tool_use", id: "ignored" },
      ],
    });
    const text = await runCompletion({ ANTHROPIC_API_KEY: "a-key" }, REQUEST);
    expect(text).toBe("[]");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.anthropic.com/v1/messages");
    expect(requestHeaders(fetchMock)["x-api-key"]).toBe("a-key");
    expect(requestHeaders(fetchMock)["anthropic-version"]).toBe("2023-06-01");
    const body = requestBody(fetchMock);
    expect(body.model).toBe("claude-sonnet-5");
    expect(body.system).toBe("system prompt");
    expect(body.messages).toEqual([{ role: "user", content: "user prompt" }]);
    expect(body.max_tokens).toBe(1024);
  });

  it("calls the OpenAI Responses API and reads output_text items", async () => {
    const fetchMock = mockFetch({
      output: [
        { type: "reasoning", summary: [] },
        { type: "message", content: [{ type: "output_text", text: "[]" }] },
      ],
    });
    const text = await runCompletion({ OPENAI_API_KEY: "o-key" }, REQUEST);
    expect(text).toBe("[]");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.openai.com/v1/responses");
    expect(requestHeaders(fetchMock).Authorization).toBe("Bearer o-key");
    const body = requestBody(fetchMock);
    expect(body.model).toBe("gpt-5.6-terra");
    expect(body.instructions).toBe("system prompt");
    expect(body.input).toBe("user prompt");
    expect(body.max_output_tokens).toBe(1024);
  });

  it("prefers the aggregated output_text field when OpenAI provides it", async () => {
    mockFetch({ output_text: "aggregated" });
    expect(await runCompletion({ OPENAI_API_KEY: "o-key" }, REQUEST)).toBe("aggregated");
  });

  it("calls the Gemini generateContent API with a system instruction", async () => {
    const fetchMock = mockFetch({
      candidates: [{ content: { parts: [{ text: "[" }, { text: "]" }] } }],
    });
    const text = await runCompletion({ GEMINI_API_KEY: "g-key" }, REQUEST);
    expect(text).toBe("[]");
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
    );
    expect(requestHeaders(fetchMock)["x-goog-api-key"]).toBe("g-key");
    const body = requestBody(fetchMock);
    expect(body.systemInstruction).toEqual({ parts: [{ text: "system prompt" }] });
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "user prompt" }] }]);
    expect(body.generationConfig).toEqual({ maxOutputTokens: 1024 });
  });

  it("calls the xAI chat completions API with system+user messages", async () => {
    const fetchMock = mockFetch({ choices: [{ message: { role: "assistant", content: "[]" } }] });
    const text = await runCompletion({ XAI_API_KEY: "x-key" }, REQUEST);
    expect(text).toBe("[]");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.x.ai/v1/chat/completions");
    expect(requestHeaders(fetchMock).Authorization).toBe("Bearer x-key");
    const body = requestBody(fetchMock);
    expect(body.model).toBe("grok-4.5");
    expect(body.messages).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: "user prompt" },
    ]);
  });

  it("surfaces provider HTTP errors with the provider name", async () => {
    mockFetch({}, 429);
    await expect(runCompletion({ ANTHROPIC_API_KEY: "a" }, REQUEST)).rejects.toThrow(
      "Anthropic (Claude) API returned 429",
    );
    mockFetch({}, 500);
    await expect(runCompletion({ XAI_API_KEY: "x" }, REQUEST)).rejects.toThrow(
      "xAI (Grok) API returned 500",
    );
  });
});
