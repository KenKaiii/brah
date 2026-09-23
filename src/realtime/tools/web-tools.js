import dns from "node:dns/promises";
import net from "node:net";
import { isBlockedHostname, isBlockedIp } from "./net-guard.js";
import { hasHostedWebSearchAuth, runHostedWebSearch } from "./openai-web-search.js";

const defaultFetchMaxLength = 8000;
const maxFetchMaxLength = 20_000;
const defaultSearchMaxResults = 5;
const maxSearchResults = 10;
const fetchTimeoutMs = 15_000;
const maxResponseBytes = 3 * 1024 * 1024;
// Below this much readable text an HTML page is almost certainly a JS shell,
// a consent wall, or a bot challenge rather than the real content.
const thinPageChars = 200;
const mainContentMinChars = 300;
// Search engines and many sites serve bot-challenge pages to non-browser
// agents, so present as a regular desktop browser.
const browserUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const fallbackUserAgent = "Brah/0.1 (+https://github.com/unstablemind/brah)";

/**
 * @param {string} name
 * @param {unknown} args
 * @param {{ auth?: object, timezone?: string, logger?: (event: string, details: object) => void, fetchImpl?: typeof fetch, now?: Date }} [options]
 */
export async function executeWebTool(name, args, options = {}) {
  switch (name) {
    case "web_fetch":
      return webFetch(args, options);
    case "web_search":
      return webSearch(args, options);
    default:
      return null;
  }
}

async function webSearch(args, options) {
  if (!isRecord(args) || typeof args.query !== "string" || !args.query.trim()) {
    return invalidArguments("query must be a non-empty string.");
  }
  const query = args.query.trim().slice(0, 500);
  const maxResults = clampInteger(args.maxResults, defaultSearchMaxResults, 1, maxSearchResults);
  const log = options.logger ?? (() => {});
  const startedAt = Date.now();

  let hostedError;
  if (hasHostedWebSearchAuth(options.auth)) {
    const hosted = await runHostedWebSearch({
      task: query,
      auth: options.auth,
      fetchImpl: options.fetchImpl,
      timezone: options.timezone,
      now: options.now,
    });
    log("web_search.hosted", {
      query,
      ok: hosted.ok,
      error: hosted.ok ? undefined : hosted.error,
      sources: hosted.ok ? hosted.value.sources.length : 0,
      elapsedMs: Date.now() - startedAt,
    });
    if (hosted.ok) {
      const { answer, sources, queries, provider } = hosted.value;
      return {
        status: "searched",
        provider,
        query,
        answer,
        sources,
        searchQueries: queries,
        resultCount: sources.length,
        results: sources.map((source) => ({ ...source, snippet: "" })),
        message: answer,
      };
    }
    hostedError = hosted.error;
  }

  const fallback = await duckDuckGoSearch(query, maxResults, options.fetchImpl);
  log("web_search.duckduckgo", {
    query,
    ok: fallback.ok,
    resultCount: fallback.ok ? fallback.results.length : 0,
    error: fallback.ok ? undefined : fallback.error,
    elapsedMs: Date.now() - startedAt,
  });
  if (!fallback.ok) {
    return {
      status: "error",
      provider: "duckduckgo",
      query,
      results: [],
      resultCount: 0,
      message: `Web search failed: ${fallback.error}${hostedError ? ` (OpenAI web search also failed: ${hostedError})` : ""}. Tell the user search is unavailable right now rather than guessing.`,
    };
  }
  const { results } = fallback;
  return {
    status: "searched",
    provider: "duckduckgo",
    query,
    resultCount: results.length,
    results,
    ...(hostedError ? { fallbackReason: hostedError } : {}),
    message:
      results.length > 0
        ? `${formatSearchResultSummary(results)}\n\nThese are search snippets only. If they don't clearly answer the question, call web_fetch on the most relevant URL before answering.`
        : "No results found. Try a shorter or differently worded query.",
  };
}

async function duckDuckGoSearch(query, maxResults, fetchImpl = fetch) {
  const searchUrl = new URL("https://html.duckduckgo.com/html/");
  searchUrl.searchParams.set("q", query);
  try {
    const response = await fetchImpl(searchUrl.toString(), {
      signal: AbortSignal.timeout(fetchTimeoutMs),
      headers: browserHeaders(browserUserAgent),
    });
    const html = await response.text();
    // DDG answers bots with HTTP 202 and an "anomaly" challenge page.
    if (response.status === 202 || /anomaly-modal|challenge-form/i.test(html)) {
      return { ok: false, error: "DuckDuckGo blocked the request with a bot challenge" };
    }
    if (!response.ok) {
      return { ok: false, error: `DuckDuckGo returned HTTP ${response.status}` };
    }
    return { ok: true, results: parseDuckDuckGoResults(html).slice(0, maxResults) };
  } catch (error) {
    return { ok: false, error: describeFetchError(error) };
  }
}

// Walks every anchor in document order: a `result__a` anchor starts a result,
// the next `result__snippet` anchor fills its snippet. Attribute order varies,
// so attributes are matched independently.
export function parseDuckDuckGoResults(html) {
  const results = [];
  let current = null;
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attributes = match[1];
    const className = attributes.match(/\bclass="([^"]*)"/i)?.[1] ?? "";
    if (/\bresult__a\b/.test(className)) {
      const href = attributes.match(/\bhref="([^"]*)"/i)?.[1] ?? "";
      const url = normalizeDuckDuckGoUrl(decodeHtmlEntities(href));
      const title = stripTags(match[2]);
      current = url && title && !isDuckDuckGoAdUrl(url) ? { title, url, snippet: "" } : null;
      if (current) {
        results.push(current);
      }
    } else if (/\bresult__snippet\b/.test(className) && current && !current.snippet) {
      current.snippet = stripTags(match[2]);
    }
  }
  return dedupeResults(results);
}

function normalizeDuckDuckGoUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl, "https://duckduckgo.com");
    const target = parsed.searchParams.get("uddg") ?? parsed.toString();
    const url = new URL(target);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function isDuckDuckGoAdUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.endsWith("duckduckgo.com") || parsed.pathname === "/y.js";
  } catch {
    return true;
  }
}

function formatSearchResultSummary(results) {
  return results
    .map(
      (result, index) =>
        `${index + 1}. ${result.title} — ${result.url}${result.snippet ? `\n   ${result.snippet}` : ""}`,
    )
    .join("\n");
}

function dedupeResults(results) {
  const seen = new Set();
  return results.filter((result) => {
    if (seen.has(result.url)) {
      return false;
    }
    seen.add(result.url);
    return true;
  });
}

async function webFetch(args, options) {
  if (!isRecord(args) || typeof args.url !== "string") {
    return invalidArguments("url must be a string.");
  }
  const url = parsePublicHttpUrl(args.url.trim());
  if (!url.ok) {
    return invalidArguments(url.message);
  }
  const maxLength = clampInteger(args.maxLength, defaultFetchMaxLength, 500, maxFetchMaxLength);
  const startIndex = clampInteger(args.startIndex, 0, 0, Number.MAX_SAFE_INTEGER);
  const log = options.logger ?? (() => {});
  const startedAt = Date.now();

  try {
    await assertPublicHost(url.value);
  } catch (error) {
    return invalidArguments(
      error instanceof Error ? error.message : "Resolved address is not allowed.",
    );
  }

  const direct = await fetchReadablePage(url.value, options.fetchImpl);
  log("web_fetch.direct", {
    url: url.value.toString(),
    ok: direct.ok,
    httpStatus: direct.httpStatus,
    textLength: direct.ok ? direct.text.length : 0,
    problem: direct.problem,
    elapsedMs: Date.now() - startedAt,
  });

  // Continuing a page the agent already started reading must stay on the same
  // (direct) text so startIndex offsets line up.
  if (direct.ok && (!direct.problem || startIndex > 0)) {
    return pageResult(direct, { startIndex, maxLength });
  }

  if (hasHostedWebSearchAuth(options.auth)) {
    const hosted = await runHostedWebSearch({
      task: `Open and read this exact page: ${url.value.toString()}\nReport its main content faithfully and in detail: key facts, names, numbers, dates, and any lists or tables, in plain text (up to about 600 words). Do not substitute a different page unless the exact page cannot be opened; if so, say that first.`,
      auth: options.auth,
      fetchImpl: options.fetchImpl,
      timezone: options.timezone,
      now: options.now,
    });
    log("web_fetch.hosted", {
      url: url.value.toString(),
      ok: hosted.ok,
      error: hosted.ok ? undefined : hosted.error,
      elapsedMs: Date.now() - startedAt,
    });
    if (hosted.ok) {
      return {
        status: "read",
        ok: true,
        provider: hosted.value.provider,
        url: url.value.toString(),
        title: direct.ok ? direct.title : undefined,
        text: hosted.value.answer,
        sources: hosted.value.sources,
        truncated: false,
        message: `Couldn't read the page directly (${direct.problem ?? "request failed"}), so this is a summary read through OpenAI web browsing, not the raw page text.`,
      };
    }
  }

  if (direct.ok) {
    return pageResult(direct, { startIndex, maxLength });
  }
  return {
    status: direct.httpStatus ?? "error",
    ok: false,
    url: url.value.toString(),
    message: `Could not read the page: ${direct.problem}. Try web_search for the same information, or computer_use_task with target browser if the user needs this exact page.`,
  };
}

function pageResult(page, { startIndex, maxLength }) {
  const text = page.text.slice(startIndex, startIndex + maxLength);
  const end = startIndex + text.length;
  const truncated = end < page.text.length;
  return {
    status: page.httpStatus,
    ok: page.httpStatus < 400,
    url: page.url,
    title: page.title,
    ...(page.description ? { description: page.description } : {}),
    contentType: page.contentType,
    text,
    totalLength: page.text.length,
    truncated,
    ...(truncated ? { nextStartIndex: end } : {}),
    ...(page.problem
      ? {
          message: `Warning: ${page.problem}. The text may be incomplete; for the real content try computer_use_task with target browser.`,
        }
      : truncated
        ? {
            message: `Showing characters ${startIndex}-${end} of ${page.text.length}. Call web_fetch again with startIndex ${end} to keep reading.`,
          }
        : {}),
  };
}

// Fetches and extracts readable text. Returns ok:false only when there is no
// usable body at all; `problem` flags weak-but-present content.
async function fetchReadablePage(url, fetchImpl = fetch) {
  const signal = AbortSignal.timeout(fetchTimeoutMs);
  try {
    let { response, finalUrl } = await fetchPublic(url, {
      signal,
      fetchImpl,
      userAgent: browserUserAgent,
    });
    // Cloudflare sometimes challenges browser-looking agents but lets a plain
    // bot UA through (same trick OpenCode's webfetch uses).
    if (response.status === 403 && response.headers.get("cf-mitigated") === "challenge") {
      ({ response, finalUrl } = await fetchPublic(url, {
        signal,
        fetchImpl,
        userAgent: fallbackUserAgent,
      }));
    }
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const httpStatus = response.status;
    if (!isTextualContentType(contentType)) {
      await response.body?.cancel?.();
      return {
        ok: false,
        httpStatus,
        problem: `the URL returned ${contentType.split(";")[0] || "an unknown content type"}, which can't be read as text`,
      };
    }
    const body = await readBodyText(response, contentType);
    const page = extractReadable(body, contentType);
    let problem;
    if (httpStatus >= 400) {
      problem = `the site returned HTTP ${httpStatus}`;
    } else if (isHtml(contentType) && looksLikeBlockedOrScriptShell(body, page.text)) {
      problem =
        "the page has almost no readable text (it likely needs JavaScript or blocked automated access)";
    }
    if (!page.text) {
      return { ok: false, httpStatus, problem: problem ?? "the page was empty" };
    }
    return {
      ok: true,
      httpStatus,
      url: finalUrl,
      contentType: contentType.split(";")[0],
      problem,
      ...page,
    };
  } catch (error) {
    return { ok: false, problem: describeFetchError(error, signal) };
  }
}

async function fetchPublic(url, { signal, fetchImpl, userAgent, maxRedirects = 5 }) {
  let current = new URL(url);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicHost(current); // re-check each hop (also blocks literal-IP Location)
    const response = await fetchImpl(current.toString(), {
      signal,
      redirect: "manual",
      headers: browserHeaders(userAgent),
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel?.();
      current = new URL(location, current);
      if (current.protocol !== "http:" && current.protocol !== "https:") {
        throw new Error("Redirect to non-http(s) URL blocked.");
      }
      const literal = current.hostname.replace(/^\[|\]$/g, "");
      if (net.isIP(literal) ? isBlockedIp(literal) : isBlockedHostname(literal)) {
        throw new Error("Redirect to a local or private address blocked.");
      }
      continue;
    }
    return { response, finalUrl: response.url || current.toString() };
  }
  throw new Error("Too many redirects.");
}

function browserHeaders(userAgent) {
  return {
    "User-Agent": userAgent,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,text/plain;q=0.8,*/*;q=0.5",
    "Accept-Language": "en-US,en;q=0.9",
  };
}

// Reads at most maxResponseBytes so a huge or endless body can't stall the
// call or blow up memory; honours the declared charset.
async function readBodyText(response, contentType) {
  const charset = contentType.match(/charset=([^;\s]+)/)?.[1]?.replace(/"/g, "") ?? "utf-8";
  let decoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    return (await response.text()).slice(0, maxResponseBytes);
  }
  let received = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    received += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (received >= maxResponseBytes) {
      await reader.cancel();
      break;
    }
  }
  return text + decoder.decode();
}

// A genuinely tiny page (example.com) is fine; a big HTML payload with almost
// no text, or a known challenge page, is a JS app shell or bot wall.
function looksLikeBlockedOrScriptShell(html, text) {
  if (
    text.length < 600 &&
    /just a moment\.\.\.|cf-browser-verification|challenge-platform|enable javascript|please turn on javascript|are you a robot|captcha/i.test(
      html,
    )
  ) {
    return true;
  }
  return text.length < thinPageChars && html.length > 5000;
}

function isTextualContentType(contentType) {
  if (!contentType) {
    return true; // many servers omit it for HTML; let extraction decide
  }
  return (
    /^(text\/|application\/(xhtml\+xml|xml|json|ld\+json|rss\+xml|atom\+xml|javascript))/.test(
      contentType,
    ) || /\+(json|xml)\b/.test(contentType)
  );
}

function isHtml(contentType) {
  return !contentType || contentType.includes("html");
}

function extractReadable(body, contentType) {
  if (isHtml(contentType) && /<(html|body|head|div|p)\b/i.test(body)) {
    return {
      title: extractHtmlTitle(body),
      description: extractMetaDescription(body),
      text: extractHtmlText(body),
    };
  }
  if (contentType.includes("json")) {
    try {
      return { text: JSON.stringify(JSON.parse(body), null, 1) };
    } catch {
      return { text: cleanupText(body) };
    }
  }
  return { text: cleanupText(body) };
}

function extractHtmlTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = match ? cleanupText(match[1]).slice(0, 200) : "";
  return title || metaContent(html, "og:title")?.slice(0, 200) || undefined;
}

function extractMetaDescription(html) {
  const description = metaContent(html, "description") ?? metaContent(html, "og:description");
  return description ? description.slice(0, 400) : undefined;
}

function metaContent(html, key) {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const name = tag.match(/\b(?:name|property)\s*=\s*["']([^"']+)["']/i)?.[1];
    if (name?.toLowerCase() === key) {
      const content = tag.match(/\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i);
      const value = cleanupText(content?.[1] ?? content?.[2] ?? "");
      return value || undefined;
    }
  }
  return undefined;
}

// Regex-based readability: drop non-content elements, prefer <article>/<main>
// when they hold real text, and keep headings/list structure so the model can
// navigate the result.
export function extractHtmlText(html) {
  const body = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  const cleaned = body
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Drop every attribute (quote-aware: attribute values may contain `>`, e.g.
    // Wikipedia's data-mw JSON) so later tag patterns only see bare tags.
    .replace(/<(\/?[a-z][\w:-]*)(?:[^>"']|"[^"]*"|'[^']*')*>/gi, "<$1>")
    .replace(
      /<(script|style|noscript|template|svg|canvas|iframe|object|select|button|form|nav|header|footer|aside|dialog)\b[^>]*>[\s\S]*?<\/\1>/gi,
      " ",
    );
  for (const tag of ["article", "main"]) {
    const region = cleaned.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*)<\\/${tag}>`, "i"))?.[1];
    if (region) {
      const text = htmlFragmentToText(region);
      if (text.length >= mainContentMinChars) {
        return text;
      }
    }
  }
  return htmlFragmentToText(cleaned);
}

function htmlFragmentToText(fragment) {
  return cleanupText(
    fragment
      .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level, inner) => {
        const heading = stripTags(inner);
        return heading ? `\n\n${"#".repeat(Number(level))} ${heading}\n` : "\n";
      })
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(td|th)>/gi, " | ")
      .replace(
        /<\/(p|div|section|article|tr|table|ul|ol|blockquote|pre|dd|dt|figure|figcaption)>/gi,
        "\n",
      )
      .replace(/<[^>]+>/g, " "),
  )
    .split("\n")
    .map((line) => line.trim())
    .filter((line, index, lines) => line || lines[index - 1])
    .join("\n")
    .replace(/\n- (?=\n|$)/g, "")
    .trim();
}

function stripTags(value) {
  return cleanupText(String(value).replace(/<[^>]+>/g, " "));
}

function cleanupText(value) {
  return decodeHtmlEntities(String(value))
    .replace(/\r/g, "\n")
    .replace(/[\t \u00a0]+/g, " ")
    .replace(/\n[\t ]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const namedEntities = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
  middot: "·",
  bull: "•",
  deg: "°",
  euro: "€",
  pound: "£",
});

function decodeHtmlEntities(value) {
  return String(value).replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? Number.parseInt(entity.slice(2), 16)
          : Number(entity.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return namedEntities[entity.toLowerCase()] ?? match;
  });
}

function describeFetchError(error, signal) {
  if (signal?.aborted || error?.name === "TimeoutError") {
    return `the request timed out after ${fetchTimeoutMs / 1000}s`;
  }
  const cause = error?.cause?.code ?? error?.cause?.message;
  const message = error instanceof Error ? error.message : "request failed";
  return cause ? `${message} (${cause})` : message;
}

function parsePublicHttpUrl(rawUrl) {
  let candidate = rawUrl;
  // Voice transcripts often yield "example.com/page" without a scheme.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate) && /^[\w-]+(\.[\w-]+)+([/?#:]|$)/.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, message: "Only http:// and https:// URLs are allowed." };
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host) ? isBlockedIp(host) : isBlockedHostname(host)) {
      return {
        ok: false,
        message: "Requests to local, loopback, or private addresses are not allowed.",
      };
    }
    return { ok: true, value: url };
  } catch {
    return { ok: false, message: "url must be a valid URL." };
  }
}

// Test seam: override in tests to avoid real network/DNS.
let resolveHostAddresses = async (hostname) => {
  const records = await dns.lookup(hostname, { all: true });
  return records.map((r) => r.address);
};

export function __setHostResolverForTests(fn) {
  resolveHostAddresses = fn;
}

async function assertPublicHost(url) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isBlockedIp(host)) {
      throw new Error("Requests to local, loopback, or private addresses are not allowed.");
    }
    return;
  }
  let addresses;
  try {
    addresses = await resolveHostAddresses(host);
  } catch {
    throw new Error(`Could not find the site "${host}"; check the address is spelled correctly.`);
  }
  if (addresses.length === 0 || addresses.some(isBlockedIp)) {
    throw new Error("Resolved address is not allowed.");
  }
}

function clampInteger(value, fallback, minimum, maximum) {
  if (!Number.isInteger(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, value));
}

function invalidArguments(message) {
  return {
    status: "invalid_arguments",
    message,
  };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
