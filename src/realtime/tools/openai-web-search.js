import { parseCodexSseStream } from "./computer-use-tools.js";

// OpenAI-hosted web search, run through a small text model so the voice agent
// gets back a short, sourced answer instead of raw search-engine HTML.
//
// Auth mirrors the rest of the app: a signed-in ChatGPT subscription goes
// through the Codex responses route (streamed SSE, the same `web_search` tool
// Codex itself sends; verified 2026-09-23), otherwise a saved API key goes
// through the public Responses API. With neither, the caller falls back to the
// local DuckDuckGo scraper.

const SUBSCRIPTION_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const API_ENDPOINT = "https://api.openai.com/v1/responses";
const API_KEY_MODEL = "gpt-5.4-mini";
const DEFAULT_SUBSCRIPTION_MODEL = "gpt-6-sol";
const DEFAULT_ORIGINATOR = "ggcoder";
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_SOURCES = 6;

/**
 * @param {{ subscription?: { accessToken: string, accountId: string, model?: string } | null, apiKey?: string | null } | undefined} auth
 * @returns {boolean}
 */
export function hasHostedWebSearchAuth(auth) {
  return Boolean((auth?.subscription?.accessToken && auth.subscription.accountId) || auth?.apiKey);
}

/**
 * Asks an OpenAI model with the hosted web_search tool to answer `task`.
 * @returns {Promise<{ ok: true, value: { answer: string, sources: {title: string, url: string}[], queries: string[], provider: string, model: string } } | { ok: false, error: string }>}
 */
export async function runHostedWebSearch({
  task,
  auth,
  fetchImpl = fetch,
  signal,
  now = new Date(),
  timezone,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  if (!hasHostedWebSearchAuth(auth)) {
    return { ok: false, error: "no_credentials" };
  }
  const instructions = buildInstructions({ now, timezone });
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const webSearchTool = {
    type: "web_search",
    external_web_access: true,
    ...(timezone ? { user_location: { type: "approximate", timezone } } : {}),
  };

  try {
    const subscription = auth.subscription?.accessToken && auth.subscription.accountId;
    const model = subscription
      ? auth.subscription.model || DEFAULT_SUBSCRIPTION_MODEL
      : API_KEY_MODEL;
    const items = subscription
      ? await requestSubscription({
          auth: auth.subscription,
          model,
          instructions,
          task,
          webSearchTool,
          fetchImpl,
          signal: combinedSignal,
        })
      : await requestApiKey({
          apiKey: auth.apiKey,
          model,
          instructions,
          task,
          webSearchTool,
          fetchImpl,
          signal: combinedSignal,
        });
    const parsed = parseOutputItems(items);
    if (!parsed.answer) {
      return { ok: false, error: "Web search returned no answer." };
    }
    return {
      ok: true,
      value: { ...parsed, provider: subscription ? "openai_subscription" : "openai_api", model },
    };
  } catch (error) {
    if (timeoutSignal.aborted) {
      return { ok: false, error: `Web search timed out after ${Math.round(timeoutMs / 1000)}s.` };
    }
    return { ok: false, error: error instanceof Error ? error.message : "Web search failed." };
  }
}

function buildInstructions({ now, timezone }) {
  const date = now.toISOString().slice(0, 10);
  return [
    "You are the web research step for a realtime voice assistant.",
    `Today's date is ${date}${timezone ? ` (user's timezone: ${timezone})` : ""}.`,
    "Always use web search to verify facts before answering; prefer primary, official, and recent sources, and search again with a better query if the first results are weak.",
    "Answer in plain spoken-style prose: no markdown, no bullet lists, no URLs in the text. Lead with the direct answer, include concrete names, numbers, and dates, and keep it under about 150 words unless the request asks for more detail.",
    "If sources conflict or the information could not be found, say so plainly instead of guessing.",
  ].join("\n");
}

async function requestSubscription({
  auth,
  model,
  instructions,
  task,
  webSearchTool,
  fetchImpl,
  signal,
}) {
  const response = await fetchImpl(SUBSCRIPTION_ENDPOINT, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      "ChatGPT-Account-ID": auth.accountId,
      originator: auth.originator || DEFAULT_ORIGINATOR,
      "OpenAI-Beta": "responses=experimental",
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      model,
      instructions,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: task }] }],
      tools: [webSearchTool],
      tool_choice: "auto",
      store: false,
      stream: true,
      reasoning: { effort: "low" },
    }),
  });
  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`Web search request failed (${response.status}): ${rawText.slice(0, 200)}`);
  }
  const stream = parseCodexSseStream(rawText);
  if (stream.error) {
    throw new Error(`Web search failed: ${stream.error}`);
  }
  return stream.items;
}

async function requestApiKey({
  apiKey,
  model,
  instructions,
  task,
  webSearchTool,
  fetchImpl,
  signal,
}) {
  const response = await fetchImpl(API_ENDPOINT, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions,
      input: task,
      tools: [webSearchTool],
      tool_choice: "auto",
      store: false,
      reasoning: { effort: "low" },
    }),
  });
  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`Web search request failed (${response.status}): ${rawText.slice(0, 200)}`);
  }
  const output = JSON.parse(rawText)?.output;
  return Array.isArray(output) ? output : [];
}

function parseOutputItems(items) {
  let text = "";
  const sources = [];
  const queries = [];
  for (const item of items) {
    if (item?.type === "web_search_call") {
      const action = item.action ?? {};
      for (const query of [
        action.query,
        ...(Array.isArray(action.queries) ? action.queries : []),
      ]) {
        if (typeof query === "string" && query && !queries.includes(query)) {
          queries.push(query);
        }
      }
      continue;
    }
    if (item?.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }
    for (const content of item.content) {
      if (typeof content?.text === "string") {
        text += content.text;
      }
      for (const annotation of Array.isArray(content?.annotations) ? content.annotations : []) {
        if (annotation?.type === "url_citation" && typeof annotation.url === "string") {
          sources.push({
            title: String(annotation.title ?? "").trim(),
            url: cleanSourceUrl(annotation.url),
          });
        }
      }
    }
  }
  return {
    answer: toSpokenText(text),
    sources: dedupeByUrl(sources).slice(0, MAX_SOURCES),
    queries,
  };
}

// Strips markdown and inline citation links so the voice model never reads a
// URL aloud; the sources travel separately.
export function toSpokenText(text) {
  return String(text ?? "")
    .replace(/\s*\(\s*\[[^\]]*\]\([^)]*\)\s*\)/g, "")
    .replace(/\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanSourceUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.searchParams.get("utm_source") === "openai") {
      url.searchParams.delete("utm_source");
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function dedupeByUrl(sources) {
  const seen = new Set();
  return sources.filter((source) => {
    if (seen.has(source.url)) {
      return false;
    }
    seen.add(source.url);
    return true;
  });
}
