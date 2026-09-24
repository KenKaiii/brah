# Brah

Electron desktop voice assistant that uses the OpenAI Realtime API to listen, view the screen, control the computer (browser + OS), and manage a local planner — all in realtime.

## Layout

- `src/main.js` — Electron main process: window modes, OpenAI OAuth, IPC handlers, screenshots, auto-update.
- `src/preload.js` — context-isolated bridge; exposes the `window.brah` API to the renderer. All renderer↔main communication goes through these `ipcRenderer.invoke` channels.
- `src/os-permissions.js` — macOS/Windows OS permission status + settings deep-links.
- `src/renderer/` — UI: `index.html`, `renderer.js`, `panel.js`, `styles.css`, plus realtime playback/tool-handler glue.
- `src/realtime/prompts.js` — builds the realtime session instructions.
- `src/realtime/tool-permissions.js` — per-tool permission metadata (read/low/write/destructive/network levels).
- `src/realtime/tools/` — tool implementations dispatched by `tools/index.js` (`executeRealtimeTool`): planner, web, filesystem (incl. `find_files` in `file-search.js`), launcher (`open_link`/`open_app`/`open_file` via Electron `shell`, injected from `main.js`), screenshot, computer-use, session. All local-path tools share the home-folder sandbox in `sandbox-path.js` (symlink-escape check + denylist for credential/shell files).
- `test/` — `node --test` suites (one per tool module).

## Architecture notes

- **Tool dispatch:** `executeRealtimeTool(name, args, options)` in `src/realtime/tools/index.js` tries each module's executor in order; each returns a falsy value when it does not own the tool name. New tools must be wired into both `tool-schemas.js` (definition) and a module executor.
- **Storage:** planner + activity persist in SQLite via `node:sqlite` (`brah.db`), not JSON. Schema lives in `src/realtime/tools/database.js`. `database.js` defaults the user-data dir to `os.tmpdir()/brah-user-data` unless `setDatabaseUserDataPath()` is called (main.js sets it to Electron `userData`). Legacy JSON stores are auto-migrated once.
- **Computer use:** browser mode via Playwright (`computer-use-browser.js`), OS mode via `@nut-tree-fork/nut-js` (`computer-use-os.js`); driven through `computer-use-tools.js`.
- **Credentials:** OpenAI auth tokens are encrypted with Electron `safeStorage` (system keychain). OAuth callback uses a local server on port `1455`.
- **Auth precedence:** a signed-in ChatGPT/Codex subscription (OAuth) wins everywhere; a saved API key is only a fallback when no subscription is signed in or its refresh fails. Keep `openai:get-status`, `openai:create-realtime-secret` and `runMemoryExtraction` in `main.js` in agreement. While the subscription is connected, the renderer locks and dims the API key field.
- **Realtime over OAuth works (verified 2026-09-23):** the June 2026 failures (500 from `api.openai.com/v1/realtime/calls`, 404 from `chatgpt.com/backend-api/codex/realtime/calls`) have cleared upstream. Both routes now return **201** with an answer SDP for `gpt-realtime-2.1` and `gpt-realtime-2.1-mini` using the subscription token; real voice calls connect and log `authMethod: "oauth"`. OpenAI does not document how these minutes are billed.
  - **GPT-Live (`gpt-live-1-codex`) is still gated:** Codex's v3 "frameless" route (`.../codex/realtime/calls?intent=quicksilver&architecture=avas`, header `OpenAI-Alpha: quicksilver=v2`) returns **403 "Voice session access denied"** for Brah — most likely the signed Codex app's `x-oai-attestation` header or a per-account entitlement. Don't retry without new evidence.
  - **Text models on the subscription's `chatgpt.com/backend-api/codex/responses` route:** `gpt-6-sol`, `gpt-6-luna`, `gpt-6-astra` (and the older `gpt-5.6-*`) are accepted; `gpt-6-terra`, `gpt-5.4` and `gpt-5.4-mini` return 400 "not supported when using Codex with a ChatGPT account". The user picks the **task model** (`TASK_MODELS` in `prompts.js`, default `gpt-6-sol`, stored as `taskModel` on the agent profile) in Settings; computer use and the subscription memory extractor both use it. `gpt-5.4-mini` via chat completions is used only on the memory extractor's API-key fallback.
  - **Web tools use OpenAI's hosted `web_search` (verified 2026-09-23):** `web_search` sends `{ type: "web_search", external_web_access: true }` (the same tool Codex sends) on the subscription's Codex responses route with the task model, or on `/v1/responses` with `gpt-5.4-mini` for an API key (`openai-web-search.js`). It returns a short spoken-style `answer` plus `sources`; DuckDuckGo HTML scraping is only the fallback when there are no credentials or the hosted call fails. `web_fetch` fetches directly first and only falls back to hosted browsing for bot walls, JS-only pages, and non-text or failed responses.
  - **Re-probing:** `BRAH_REALTIME_PROBE=1 npx electron .` logs a `BRAH_PROBE {…}` line and quits; it opens sign-in if the saved login is dead. Optional env vars: `BRAH_PROBE_MODEL` (realtime model), `BRAH_PROBE_TEXT_MODELS` (comma-separated list for the Codex responses route), `BRAH_PROBE_MEMORY=1` (runs the real extractor into a throwaway temp DB; `=adversarial` adds a read-aloud page carrying an injected "remember" instruction, which must not be stored), `BRAH_PROBE_WEB="query|https://url|…"` (runs real `web_search`/`web_fetch` calls, URLs become fetches), plus `BRAH_PROBE_COMPUTER_USE=1` (also runs a real browser computer-use task on example.com) and `BRAH_PROBE_TASK_MODEL` (overrides the task model for both).
- **Memory:** facts, working notes (`soul-store.js`) and daily logs live in SQLite and are injected into every call. Two writers: the background extractor (`memory-extractor.js`, facts from the user's own turns only) and explicit voice tools (`memory-tools.js`). Every write goes through `memory-guard.js`, which refuses text that reads like instructions to the model or contains secrets; facts record their `source` (`conversation` / `voice` / `you`). `memory-write-gate.js` (enforced in `tools:execute`) refuses memory-write tools once web/file/screen content has arrived since the user last spoke; the renderer reopens it on `input_audio_buffer.committed`. SQLite triggers write every add/update/delete of facts, soul notes and daily logs to a bounded `memory_history` table; user deletions from the panel purge that item's history.
- **Window modes:** `orb`, `call`, `panel` (sizes/placement defined in `main.js`); switched via `window:set-mode`.

## Commands

- `npm start` — run the app (`electron .`).
- `npm run check` — Biome format-check + lint.
- `npm test` — `npm run check` then `node --test`.
- `npm run build:mac` — `electron-builder --mac dir` (dir target only).
- `npm run open:mac` — build then launch `dist/mac-arm64/Brah.app`.
- `npm run update:deps` — `ncu -u && npm install`.

## Build constraints

- `@nut-tree-fork/**` must stay in `asarUnpack` (native addon, can't run from asar).
- macOS build is the `dir` target with hardened runtime + the entitlements in `build/`. Code signing is auto-discovered from the keychain / `CSC_*` env vars; with no cert it falls back to ad-hoc/unsigned.
