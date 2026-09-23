import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { toSpokenText } from "../src/realtime/tools/openai-web-search.js";
import {
  __setHostResolverForTests,
  executeWebTool,
  extractHtmlText,
  parseDuckDuckGoResults,
} from "../src/realtime/tools/web-tools.js";

beforeEach(() => {
  // Avoid real DNS in tests: resolve every hostname to a public address.
  __setHostResolverForTests(async () => ["93.184.216.34"]);
});

function mockFetch(handler) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function createResponse({
  body,
  contentType = "text/html",
  ok = true,
  status = 200,
  url = "https://example.com",
  headers = {},
}) {
  const allHeaders = { "content-type": contentType, ...headers };
  return {
    ok,
    status,
    url,
    headers: {
      get(name) {
        return allHeaders[name.toLowerCase()] ?? null;
      },
    },
    async text() {
      return body;
    },
  };
}

function sseBody(items) {
  const events = [
    ...items.map((item) => ({ type: "response.output_item.done", item })),
    { type: "response.completed", response: { id: "resp_1" } },
  ];
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

const subscriptionAuth = {
  subscription: { accessToken: "token", accountId: "acct", model: "gpt-6-sol" },
  apiKey: null,
};

const hostedAnswerItems = [
  {
    type: "web_search_call",
    status: "completed",
    action: { type: "search", query: "latest iphone", queries: ["latest iphone"] },
  },
  {
    type: "message",
    role: "assistant",
    content: [
      {
        type: "output_text",
        text: "The latest is the **iPhone 18 Pro**, released September 18, 2026. ([apple.com](https://www.apple.com/newsroom/x/?utm_source=openai))",
        annotations: [
          {
            type: "url_citation",
            title: "Apple debuts iPhone 18 Pro",
            url: "https://www.apple.com/newsroom/x/?utm_source=openai",
          },
          {
            type: "url_citation",
            title: "Duplicate",
            url: "https://www.apple.com/newsroom/x/?utm_source=openai",
          },
        ],
      },
    ],
  },
];

test("web_fetch rejects non-http URLs before network access", async () => {
  const restoreFetch = mockFetch(() => {
    throw new Error("fetch should not be called");
  });
  try {
    assert.deepEqual(await executeWebTool("web_fetch", { url: "file:///etc/passwd" }), {
      status: "invalid_arguments",
      message: "Only http:// and https:// URLs are allowed.",
    });
  } finally {
    restoreFetch();
  }
});

test("web_fetch strips HTML chrome and truncates extracted text", async () => {
  const restoreFetch = mockFetch(async (url) =>
    createResponse({
      url,
      body: `<!doctype html>
        <html>
          <head><title>Example &amp; Test</title><style>.x{}</style></head>
          <body><nav>Skip this</nav><main><h1>Hello &amp; welcome</h1><p>This is useful text.</p></main><script>bad()</script></body>
        </html>`,
    }),
  );
  try {
    const result = await executeWebTool("web_fetch", {
      url: "https://example.com/page",
      maxLength: 500,
    });
    assert.equal(result.status, 200);
    assert.equal(result.ok, true);
    assert.equal(result.title, "Example & Test");
    assert.match(result.text, /# Hello & welcome/);
    assert.match(result.text, /This is useful text/);
    assert.doesNotMatch(result.text, /bad\(\)|Skip this/);
    assert.equal(result.truncated, false);
    assert.equal(result.message, undefined, "a small but real page is not flagged");
  } finally {
    restoreFetch();
  }
});

test("web_fetch accepts a scheme-less URL and pages through long text with startIndex", async () => {
  const paragraph = "word ".repeat(400);
  const requested = [];
  const restoreFetch = mockFetch(async (url) => {
    requested.push(url);
    return createResponse({ url, body: `<html><body><p>${paragraph}</p></body></html>` });
  });
  try {
    const first = await executeWebTool("web_fetch", { url: "example.com/long", maxLength: 500 });
    assert.equal(requested[0], "https://example.com/long");
    assert.equal(first.truncated, true);
    assert.equal(first.nextStartIndex, 500);
    assert.equal(first.text.length, 500);
    assert.match(first.message, /startIndex 500/);

    const second = await executeWebTool("web_fetch", {
      url: "https://example.com/long",
      maxLength: 500,
      startIndex: first.nextStartIndex,
    });
    assert.equal(second.text.length, 500);
    assert.equal(second.nextStartIndex, 1000);
  } finally {
    restoreFetch();
  }
});

test("web_fetch prefers <main> content over surrounding boilerplate", () => {
  const article = "Real article sentence with facts. ".repeat(15);
  const text = extractHtmlText(
    `<body><div class="promo">Subscribe now promo</div><main><h2>Story</h2><ul><li>One</li><li>Two</li></ul><p>${article}</p></main><div>Cookie banner</div></body>`,
  );
  assert.match(text, /^## Story/);
  assert.match(text, /- One\n- Two/);
  assert.doesNotMatch(text, /Subscribe now|Cookie banner/);
});

test("web_fetch ignores `>` inside attribute values", () => {
  const text = extractHtmlText(
    `<body><p data-mw='{"wt":"a &lt;ref name=\\"x\\">{{Cite web}}"}'>Visible text</p></body>`,
  );
  assert.equal(text, "Visible text");
});

test("web_fetch follows redirects but blocks a redirect into a private address", async () => {
  const restoreFetch = mockFetch(async (url) => {
    if (url === "https://example.com/go") {
      return createResponse({
        url,
        status: 302,
        ok: false,
        body: "",
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  try {
    const result = await executeWebTool("web_fetch", { url: "https://example.com/go" });
    assert.equal(result.ok, false);
    assert.match(result.message, /private address blocked/);
  } finally {
    restoreFetch();
  }
});

test("web_fetch falls back to OpenAI browsing when the page is a bot wall", async () => {
  const calls = [];
  const restoreFetch = mockFetch(async (url) => {
    calls.push(url);
    if (url.startsWith("https://chatgpt.com/")) {
      return createResponse({
        url,
        contentType: "text/event-stream",
        body: sseBody(hostedAnswerItems),
      });
    }
    return createResponse({
      url,
      status: 403,
      ok: false,
      body: `<html><head><title>Just a moment...</title></head><body>${"<div></div>".repeat(600)}</body></html>`,
    });
  });
  try {
    const result = await executeWebTool(
      "web_fetch",
      { url: "https://blocked.example.com/story" },
      { auth: subscriptionAuth },
    );
    assert.equal(result.status, "read");
    assert.equal(result.provider, "openai_subscription");
    assert.match(result.text, /iPhone 18 Pro/);
    assert.match(result.message, /OpenAI web browsing/);
    assert.equal(calls.length, 2);
  } finally {
    restoreFetch();
  }
});

test("web_fetch explains a failure and suggests alternatives when nothing works", async () => {
  const restoreFetch = mockFetch(async (url) =>
    createResponse({ url, status: 404, ok: false, body: "" }),
  );
  try {
    const result = await executeWebTool("web_fetch", { url: "https://example.com/missing" });
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
    assert.match(result.message, /Could not read the page/);
    assert.match(result.message, /web_search/);
  } finally {
    restoreFetch();
  }
});

test("web_fetch reports an unknown host in plain words", async () => {
  __setHostResolverForTests(async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  });
  const result = await executeWebTool("web_fetch", { url: "https://no-such-site.invalid-tld/" });
  assert.equal(result.status, "invalid_arguments");
  assert.match(result.message, /Could not find the site/);
});

test("web_search uses OpenAI hosted search on the subscription and returns a spoken answer", async () => {
  let requestBody;
  let requestHeaders;
  const restoreFetch = mockFetch(async (url, init) => {
    assert.equal(url, "https://chatgpt.com/backend-api/codex/responses");
    requestBody = JSON.parse(init.body);
    requestHeaders = init.headers;
    return createResponse({
      url,
      contentType: "text/event-stream",
      body: sseBody(hostedAnswerItems),
    });
  });
  try {
    const result = await executeWebTool(
      "web_search",
      { query: "latest iphone" },
      { auth: subscriptionAuth, timezone: "Europe/London", now: new Date("2026-09-23T10:00:00Z") },
    );
    assert.deepEqual(requestBody.tools, [
      {
        type: "web_search",
        external_web_access: true,
        user_location: { type: "approximate", timezone: "Europe/London" },
      },
    ]);
    assert.equal(requestBody.model, "gpt-6-sol");
    assert.match(requestBody.instructions, /2026-09-23/);
    assert.equal(requestHeaders["ChatGPT-Account-ID"], "acct");

    assert.equal(result.status, "searched");
    assert.equal(result.provider, "openai_subscription");
    assert.equal(result.answer, "The latest is the iPhone 18 Pro, released September 18, 2026.");
    assert.equal(result.message, result.answer);
    assert.deepEqual(result.sources, [
      { title: "Apple debuts iPhone 18 Pro", url: "https://www.apple.com/newsroom/x/" },
    ]);
    assert.deepEqual(result.searchQueries, ["latest iphone"]);
  } finally {
    restoreFetch();
  }
});

test("web_search uses the Responses API when only an API key is saved", async () => {
  const restoreFetch = mockFetch(async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(init.headers.Authorization, "Bearer sk-test");
    assert.equal(JSON.parse(init.body).tools[0].type, "web_search");
    return createResponse({
      url,
      contentType: "application/json",
      body: JSON.stringify({ output: hostedAnswerItems }),
    });
  });
  try {
    const result = await executeWebTool(
      "web_search",
      { query: "latest iphone" },
      { auth: { subscription: null, apiKey: "sk-test" } },
    );
    assert.equal(result.provider, "openai_api");
    assert.match(result.answer, /iPhone 18 Pro/);
  } finally {
    restoreFetch();
  }
});

test("web_search falls back to DuckDuckGo when hosted search fails", async () => {
  const logged = [];
  const restoreFetch = mockFetch(async (url) => {
    if (url.startsWith("https://chatgpt.com/")) {
      return createResponse({ url, status: 500, ok: false, body: "upstream error" });
    }
    return createResponse({
      url,
      body: `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">First</a>
        <a class="result__snippet" href="x">Snippet A</a>`,
    });
  });
  try {
    const result = await executeWebTool(
      "web_search",
      { query: "anything" },
      { auth: subscriptionAuth, logger: (event, details) => logged.push({ event, details }) },
    );
    assert.equal(result.status, "searched");
    assert.equal(result.provider, "duckduckgo");
    assert.match(result.fallbackReason, /500/);
    assert.match(result.message, /call web_fetch/);
    assert.deepEqual(
      logged.map((entry) => entry.event),
      ["web_search.hosted", "web_search.duckduckgo"],
    );
  } finally {
    restoreFetch();
  }
});

test("web_search reports a DuckDuckGo bot challenge as an error, not zero results", async () => {
  const restoreFetch = mockFetch(async (url) =>
    createResponse({ url, status: 202, body: '<div class="anomaly-modal">challenge</div>' }),
  );
  try {
    const result = await executeWebTool("web_search", { query: "anything" });
    assert.equal(result.status, "error");
    assert.match(result.message, /bot challenge/);
  } finally {
    restoreFetch();
  }
});

test("DuckDuckGo parser pairs snippets with titles, decodes redirects, and dedupes", () => {
  const results = parseDuckDuckGoResults(`
    <div class="result">
      <h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=abc">First &amp; Result</a></h2>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Useful <b>summary</b> text.</a>
    </div>
    <div class="result">
      <h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">Duplicate</a></h2>
    </div>
    <div class="result">
      <h2><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Sponsored</a></h2>
      <a class="result__snippet">Ad text.</a>
    </div>
    <div class="result">
      <h2><a class="result__a" href="https://example.com/b">Second Result</a></h2>
      <a class="result__snippet">Second summary.</a>
    </div>`);
  assert.deepEqual(results, [
    { title: "First & Result", url: "https://example.com/a", snippet: "Useful summary text." },
    { title: "Second Result", url: "https://example.com/b", snippet: "Second summary." },
  ]);
});

test("toSpokenText removes markdown, citation links, and bare URLs", () => {
  assert.equal(
    toSpokenText(
      "**Short answer:** it's [Apple](https://apple.com) news. ([apple.com](https://apple.com/x?y=1)) See https://x.y/z.",
    ),
    "Short answer: it's Apple news. See",
  );
});

test("web_fetch blocks private, loopback, and link-local hosts before network access", async () => {
  const blockedUrls = [
    "http://127.0.0.1:1455/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://localhost/",
    "http://[::1]/",
    "http://2130706433/", // decimal 127.0.0.1
  ];
  for (const url of blockedUrls) {
    const restoreFetch = mockFetch(() => {
      throw new Error(`fetch should not be called for ${url}`);
    });
    try {
      const result = await executeWebTool("web_fetch", { url });
      assert.equal(result.status, "invalid_arguments", `expected ${url} to be rejected`);
    } finally {
      restoreFetch();
    }
  }
});

test("web_fetch blocks hosts that resolve to private addresses (DNS rebinding)", async () => {
  __setHostResolverForTests(async () => ["10.1.2.3"]);
  const restoreFetch = mockFetch(() => {
    throw new Error("fetch should not be called");
  });
  try {
    const result = await executeWebTool("web_fetch", { url: "https://rebind.example.com/" });
    assert.equal(result.status, "invalid_arguments");
  } finally {
    restoreFetch();
  }
});

test("unknown web tool names pass through as null", async () => {
  assert.equal(await executeWebTool("not_a_web_tool", {}), null);
});
