import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserComputerTarget } from "../src/realtime/tools/computer-use-browser.js";

test("closes Chromium when browser context setup fails", async () => {
  let closed = false;
  const failure = new Error("context unavailable");
  const playwright = {
    chromium: {
      async launch() {
        return {
          async newContext() {
            throw failure;
          },
          async close() {
            closed = true;
          },
        };
      },
    },
  };

  await assert.rejects(() => createBrowserComputerTarget({ playwright }), failure);
  assert.equal(closed, true);
});

test("closes Chromium when initial navigation fails", async () => {
  let closed = false;
  const failure = new Error("navigation failed");
  const playwright = {
    chromium: {
      async launch() {
        return {
          async newContext() {
            return {
              async newPage() {
                return {
                  goto: async () => {
                    throw failure;
                  },
                };
              },
            };
          },
          async close() {
            closed = true;
          },
        };
      },
    },
  };

  await assert.rejects(
    () => createBrowserComputerTarget({ playwright, url: "https://example.com" }),
    failure,
  );
  assert.equal(closed, true);
});
