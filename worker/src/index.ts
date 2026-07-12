/**
 * CodeFerret — Cloudflare Worker proxy.
 * Zero-retention middleware between GitHub webhooks and the Claude API:
 * verifies the webhook signature, scrubs secrets from the payload, fetches the
 * PR diff, runs the review, and posts findings back as PR review comments.
 * Nothing is persisted; all data lives only in the request's memory.
 */

export interface Env {
  ANTHROPIC_API_KEY: string;
  GITHUB_TOKEN: string;
  GITHUB_WEBHOOK_SECRET: string;
  KV_SETTINGS?: KVNamespace;
  D1_SUPPRESSIONS?: D1Database;
}

const SECRET_PATTERNS: RegExp[] = [
  /(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36}/g,
  /(A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/g,
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /(?:Bearer\s+|api_key["':\s]+|secret["':\s]+)([a-zA-Z0-9_\-.]{20,})/gi,
  /xox[pborsa]-[0-9]{10,13}-[0-9]{10,13}-[0-9A-Za-z-]{10,}/g,
  /-----BEGIN (?:RSA|OPENSSH|EC|DSA|PGP) PRIVATE KEY-----[\s\S]*?-----END (?:RSA|OPENSSH|EC|DSA|PGP) PRIVATE KEY-----/g,
];

function scrubSecrets(text: string): string {
  let sanitized = text;
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[REDACTED_SECRET]");
  }
  return sanitized;
}

async function verifySignature(secret: string, payload: string, signature: string | null): Promise<boolean> {
  if (!signature?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const expected =
    "sha256=" +
    Array.from(new Uint8Array(mac))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

interface Finding {
  file: string;
  line: number;
  character: number;
  severity: "CRITICAL" | "WARNING" | "SUGGESTION";
  vector: "LOGIC" | "SECURITY" | "CONCURRENCY" | "PERFORMANCE" | "API";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  message: string;
  explanation: string;
  patch: string | null;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const rawPayload = await request.text();

    const valid = await verifySignature(
      env.GITHUB_WEBHOOK_SECRET,
      rawPayload,
      request.headers.get("x-hub-signature-256"),
    );
    if (!valid) {
      return new Response("Invalid signature", { status: 401 });
    }

    const event = request.headers.get("x-github-event") ?? "";
    if (event !== "pull_request") {
      return new Response("Event ignored", { status: 200 });
    }

    let payload: any;
    try {
      payload = JSON.parse(rawPayload);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    if (!["opened", "synchronize", "reopened"].includes(payload.action)) {
      return new Response("Action ignored", { status: 200 });
    }

    // GitHub times out webhook deliveries at 10s; ack now, review in background.
    ctx.waitUntil(reviewPullRequest(payload, env));

    return new Response(JSON.stringify({ status: "accepted", message: "Review queued" }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  },
} satisfies ExportedHandler<Env>;

async function reviewPullRequest(payload: any, env: Env): Promise<void> {
  const repo: string = payload.repository.full_name;
  const prNumber: number = payload.pull_request.number;
  const headSha: string = payload.pull_request.head.sha;

  const gh = (path: string, init: RequestInit = {}) =>
    fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "codeferret-worker",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.headers ?? {}),
      },
    });

  const checkRes = await gh(`/repos/${repo}/check-runs`, {
    method: "POST",
    body: JSON.stringify({ name: "CodeFerret", head_sha: headSha, status: "in_progress" }),
  });
  const checkRun = checkRes.ok ? await checkRes.json<any>() : null;

  try {
    const diffRes = await gh(`/repos/${repo}/pulls/${prNumber}`, {
      headers: { Accept: "application/vnd.github.v3.diff" },
    });
    if (!diffRes.ok) throw new Error(`diff fetch failed: ${diffRes.status}`);
    const diff = scrubSecrets(await diffRes.text());

    const findings = await runClaudeReview(diff, env);
    const active = await filterSuppressed(findings, repo, env);

    if (active.length > 0) {
      const comments = active
        .filter((f) => f.line > 0)
        .map((f) => ({
          path: f.file,
          line: f.line,
          side: "RIGHT",
          body:
            `**[${f.severity} · ${f.vector} · ${f.confidence}]** ${f.message}\n\n` +
            `${f.explanation}` +
            (f.patch ? `\n\n\`\`\`diff\n${f.patch}\n\`\`\`` : ""),
        }));
      await gh(`/repos/${repo}/pulls/${prNumber}/reviews`, {
        method: "POST",
        body: JSON.stringify({
          commit_id: headSha,
          event: "COMMENT",
          body: `CodeFerret found ${active.length} issue(s).`,
          comments,
        }),
      });
    }

    const blocking = active.some((f) => f.severity === "CRITICAL" && f.confidence === "HIGH");
    const conclusion = blocking ? "failure" : active.length > 0 ? "neutral" : "success";
    if (checkRun) {
      await gh(`/repos/${repo}/check-runs/${checkRun.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: "completed",
          conclusion,
          output: {
            title: `CodeFerret: ${active.length} finding(s)`,
            summary: active.length
              ? active.map((f) => `- **${f.severity}** \`${f.file}:${f.line}\` — ${f.message}`).join("\n")
              : "No issues found.",
          },
        }),
      });
    }
  } catch (error) {
    console.error("CodeFerret review failed:", error);
    if (checkRun) {
      await gh(`/repos/${repo}/check-runs/${checkRun.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: "completed",
          conclusion: "neutral",
          output: { title: "CodeFerret: review errored", summary: "Internal error; review skipped." },
        }),
      });
    }
  }
}

async function runClaudeReview(diff: string, env: Env): Promise<Finding[]> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 8192,
      system:
        "You are CodeFerret, a semantic code reviewer. Analyze the unified diff for bugs across five vectors: LOGIC (off-by-one, null flow, unhandled promises, resource leaks), SECURITY (secrets, injection, XSS, unsafe deserialization), CONCURRENCY (races, deadlocks, non-atomic read-modify-write), PERFORMANCE (O(N^2) on unbounded data, N+1 queries), API (breaking public contract changes). Only report issues caused by the diff, with a concrete failure scenario. Never report style. Output ONLY a JSON array of objects with fields: file, line, character, severity (CRITICAL|WARNING|SUGGESTION), vector, confidence (HIGH|MEDIUM|LOW), message, explanation, patch (unified diff or null). Output [] if clean.",
      messages: [{ role: "user", content: `Review this pull request diff:\n\n${diff}` }],
    }),
  });
  if (!response.ok) throw new Error(`Claude API returned ${response.status}`);
  const data = await response.json<any>();
  const text: string = data.content?.[0]?.text ?? "[]";
  const match = text.match(/\[[\s\S]*\]/);
  return match ? (JSON.parse(match[0]) as Finding[]) : [];
}

async function filterSuppressed(findings: Finding[], repo: string, env: Env): Promise<Finding[]> {
  if (!env.D1_SUPPRESSIONS) return findings;
  const out: Finding[] = [];
  for (const f of findings) {
    const basename = f.file.split("/").pop() ?? f.file;
    const normalized = f.message.toLowerCase().trim().replace(/\d+/g, "N").replace(/\s+/g, " ");
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${basename}|${f.vector}|${normalized}`),
    );
    const hash = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);
    const row = await env.D1_SUPPRESSIONS.prepare(
      "SELECT 1 FROM suppressions WHERE repo = ? AND hash = ?",
    )
      .bind(repo, hash)
      .first();
    if (!row) out.push(f);
  }
  return out;
}
