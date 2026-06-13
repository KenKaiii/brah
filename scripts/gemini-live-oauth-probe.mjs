// Phase 0 probe: can a Google OAuth token (gemini-cli installed-app client)
// with the generative-language scope drive the Gemini Live API?
//
// Usage: node scripts/gemini-live-oauth-probe.mjs
// Opens a browser for consent, then probes:
//   1. Ephemeral token mint (v1alpha AuthTokenService) with the OAuth Bearer.
//   2. Live WS connect with ?access_token=<ephemeral> (renderer-friendly path).
//   3. Live WS connect with Authorization: Bearer <oauth> (main-process path).
// Prints a PASS/FAIL summary; never persists or prints full tokens.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";

// Supply the gemini-cli installed-app OAuth client via env vars so no credential
// is committed (GitHub push protection blocks hardcoded Google OAuth secrets):
//   GEMINI_OAUTH_CLIENT_ID=… GEMINI_OAUTH_CLIENT_SECRET=… node scripts/gemini-live-oauth-probe.mjs
const CLIENT_ID = process.env.GEMINI_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GEMINI_OAUTH_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "Set GEMINI_OAUTH_CLIENT_ID and GEMINI_OAUTH_CLIENT_SECRET (gemini-cli installed-app client) before running.",
  );
  process.exit(1);
}
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const MODEL = "gemini-3.1-flash-live-preview";
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/generative-language",
].join(" ");
const WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const WS_EPHEMERAL_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";

function log(label, message) {
  console.log(`[probe] ${label}: ${message}`);
}

function base64url(buffer) {
  return buffer.toString("base64url");
}

async function login() {
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  const state = crypto.randomBytes(24).toString("hex");

  const { server, port } = await new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, "127.0.0.1", () => resolve({ server: srv, port: srv.address().port }));
    srv.on("error", reject);
  });
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);

  const code = await new Promise((resolve, reject) => {
    server.on("request", (req, res) => {
      const reqUrl = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (reqUrl.pathname !== "/oauth2callback") {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      if (reqUrl.searchParams.get("state") !== state) {
        res.statusCode = 400;
        res.end("State mismatch");
        reject(new Error("OAuth state mismatch"));
        return;
      }
      const error = reqUrl.searchParams.get("error");
      if (error) {
        res.end(`<h1>Login failed: ${error}</h1>`);
        reject(new Error(`OAuth error: ${error}`));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h1>Login complete</h1><p>Return to the terminal.</p>");
      resolve(reqUrl.searchParams.get("code"));
    });
    const timer = setTimeout(() => reject(new Error("Login timed out (5 min).")), 300_000);
    timer.unref();
    log("login", `opening browser (redirect port ${port})…`);
    spawn("open", [url.toString()], { stdio: "ignore", detached: true }).unref();
  }).finally(() => server.close());

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`Token exchange failed (${response.status}): ${JSON.stringify(json)}`);
  }
  log("login", `token acquired; scopes granted: ${json.scope}`);
  return json.access_token;
}

async function mintEphemeralToken(accessToken) {
  // AuthTokenService.CreateToken — REST surface for ephemeral Live tokens.
  const body = {
    uses: 1,
    expireTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    newSessionExpireTime: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
    liveConnectConstraints: {
      model: `models/${MODEL}`,
      config: { responseModalities: ["AUDIO"] },
    },
  };
  for (const path of ["v1alpha/auth_tokens", "v1alpha/authTokens"]) {
    const response = await fetch(`https://generativelanguage.googleapis.com/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (response.ok) {
      const parsed = JSON.parse(text);
      log("ephemeral", `mint OK via ${path} (name: ${parsed.name?.slice(0, 24)}…)`);
      return parsed.name;
    }
    log("ephemeral", `mint via ${path} failed (${response.status}): ${text.slice(0, 200)}`);
  }
  return null;
}

function probeWebSocket(label, url, headers) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok, message) => {
      if (settled) return;
      settled = true;
      log(label, `${ok ? "PASS" : "FAIL"} — ${message}`);
      resolve(ok);
    };
    let ws;
    try {
      ws = new WebSocket(url, headers ? { headers } : undefined);
    } catch (error) {
      finish(false, `constructor error: ${error.message}`);
      return;
    }
    const timer = setTimeout(() => {
      finish(false, "timeout (15s)");
      try {
        ws.close();
      } catch {
        // already closed
      }
    }, 15_000);
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          setup: {
            model: `models/${MODEL}`,
            generationConfig: { responseModalities: ["AUDIO"] },
          },
        }),
      );
    };
    ws.onmessage = async (event) => {
      const text =
        typeof event.data === "string"
          ? event.data
          : Buffer.from(await event.data.arrayBuffer()).toString();
      clearTimeout(timer);
      const isSetupComplete = text.includes("setupComplete");
      finish(isSetupComplete, `server message: ${text.slice(0, 200)}`);
      try {
        ws.close();
      } catch {
        // already closed
      }
    };
    ws.onclose = (event) => {
      clearTimeout(timer);
      finish(false, `closed code=${event.code} reason=${(event.reason || "(none)").slice(0, 200)}`);
    };
  });
}

const accessToken = await login();
const results = {};

const ephemeralToken = await mintEphemeralToken(accessToken);
results.ephemeralMint = Boolean(ephemeralToken);
if (ephemeralToken) {
  results.ephemeralWs = await probeWebSocket(
    "ws-ephemeral",
    `${WS_EPHEMERAL_BASE}?access_token=${encodeURIComponent(ephemeralToken)}`,
  );
}

results.bearerWs = await probeWebSocket("ws-bearer", WS_BASE, {
  Authorization: `Bearer ${accessToken}`,
});

console.log("\n=== SUMMARY ===");
console.log(`ephemeral mint:        ${results.ephemeralMint ? "PASS" : "FAIL"}`);
console.log(
  `ephemeral WS connect:  ${results.ephemeralWs === undefined ? "SKIPPED" : results.ephemeralWs ? "PASS" : "FAIL"}`,
);
console.log(`bearer WS connect:     ${results.bearerWs ? "PASS" : "FAIL"}`);
