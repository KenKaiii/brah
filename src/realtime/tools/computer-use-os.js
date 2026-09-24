import { capturePrimaryScreenPng } from "./screenshot-tools.js";

const supportedPlatforms = new Set(["darwin", "win32", "linux"]);

/**
 * Create an OS-level computer-use target that drives the real machine via nut.js.
 * Returns the same contract as the browser target so the computer-use loop and
 * action executor work unchanged.
 *
 * @param {object} options
 * @param {object} [options.nut] Injected nut.js module (defaults to @nut-tree-fork/nut-js).
 * @param {object} options.desktopCapturer Electron desktopCapturer.
 * @param {object} options.screen Electron screen module.
 * @param {string} [options.platform] process.platform override (for tests).
 * @returns {Promise<object>} Computer target.
 */
export async function createOsComputerTarget(options = {}) {
  const platform = options.platform ?? process.platform;
  if (!supportedPlatforms.has(platform)) {
    throw new Error(`OS computer use is not supported on platform "${platform}".`);
  }

  const nut = options.nut ?? (await loadNut());
  const { Point, Button, Key, mouse, keyboard, sleep } = nut;
  const geometry = resolveGeometry(options.screen);

  let displayWidth = geometry.logicalWidth;
  let displayHeight = geometry.logicalHeight;

  const scaleX = () => geometry.logicalWidth / displayWidth;
  const scaleY = () => geometry.logicalHeight / displayHeight;
  const toLogical = (x, y) => new Point(Math.round(x * scaleX()), Math.round(y * scaleY()));

  const target = {
    displaySize: { width: displayWidth, height: displayHeight },
    actionTarget: {
      mouse: {
        async move(x, y) {
          await mouse.setPosition(toLogical(x, y));
        },
        async click(x, y, opts = {}) {
          await mouse.setPosition(toLogical(x, y));
          await mouse.click(mapButton(Button, opts.button));
        },
        async dblclick(x, y, opts = {}) {
          await mouse.setPosition(toLogical(x, y));
          await mouse.doubleClick(mapButton(Button, opts.button));
        },
        async down(opts = {}) {
          await mouse.pressButton(mapButton(Button, opts.button));
        },
        async up(opts = {}) {
          await mouse.releaseButton(mapButton(Button, opts.button));
        },
        async wheel(deltaX, deltaY) {
          if (deltaY > 0) {
            await mouse.scrollDown(deltaY);
          } else if (deltaY < 0) {
            await mouse.scrollUp(-deltaY);
          }
          if (deltaX > 0) {
            await mouse.scrollRight(deltaX);
          } else if (deltaX < 0) {
            await mouse.scrollLeft(-deltaX);
          }
        },
      },
      keyboard: {
        async type(text) {
          if (text) {
            await keyboard.type(text);
          }
        },
        async press(key) {
          const nutKey = mapKeyToNut(key, Key);
          await keyboard.pressKey(nutKey);
          await keyboard.releaseKey(nutKey);
        },
        async down(key) {
          await keyboard.pressKey(mapKeyToNut(key, Key));
        },
        async up(key) {
          await keyboard.releaseKey(mapKeyToNut(key, Key));
        },
      },
      wait: async (ms) => {
        if (typeof sleep === "function") {
          await sleep(ms);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, ms));
      },
    },
    async captureScreenshot() {
      // Capture at the logical display size so screenshot pixels map 1:1 to the
      // coordinate space nut.js clicks in. This removes scaling/aspect drift that
      // otherwise makes the model's coordinates land off-target.
      const capture = await capturePrimaryScreenPng({
        desktopCapturer: options.desktopCapturer,
        screen: options.screen,
        nativeImage: options.nativeImage,
        systemPreferences: options.systemPreferences,
        logger: options.logger,
        resizeTo: { width: geometry.logicalWidth, height: geometry.logicalHeight },
      });
      displayWidth = capture.width;
      displayHeight = capture.height;
      target.displaySize = { width: displayWidth, height: displayHeight };
      return capture.png;
    },
    async close() {
      // Nothing to tear down for OS control.
    },
  };

  return target;
}

const keyNameMap = Object.freeze({
  Enter: "Enter",
  Escape: "Escape",
  Control: "LeftControl",
  Meta: "LeftSuper",
  Alt: "LeftAlt",
  Shift: "LeftShift",
  Tab: "Tab",
  Space: "Space",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Home: "Home",
  End: "End",
});

const digitNames = Object.freeze({
  0: "Num0",
  1: "Num1",
  2: "Num2",
  3: "Num3",
  4: "Num4",
  5: "Num5",
  6: "Num6",
  7: "Num7",
  8: "Num8",
  9: "Num9",
});

/**
 * Map a normalized key (output of computer-use-actions normalizeKey) to a nut.js Key.
 *
 * @param {string} key Normalized key name.
 * @param {object} Key nut.js Key enum.
 * @returns {number} nut.js Key value.
 */
export function mapKeyToNut(key, Key) {
  if (typeof key !== "string" || !key) {
    throw new Error("Computer key must be a non-empty string.");
  }
  const named = keyNameMap[key];
  if (named && named in Key) {
    return Key[named];
  }
  if (key.length === 1) {
    if (digitNames[key] && digitNames[key] in Key) {
      return Key[digitNames[key]];
    }
    const upper = key.toUpperCase();
    if (upper in Key) {
      return Key[upper];
    }
  }
  if (key in Key) {
    return Key[key];
  }
  throw new Error(`Unsupported computer key: ${key}`);
}

function mapButton(Button, button) {
  switch (button) {
    case "right":
      return Button.RIGHT;
    case "middle":
      return Button.MIDDLE;
    default:
      return Button.LEFT;
  }
}

function resolveGeometry(electronScreen) {
  const display = electronScreen?.getPrimaryDisplay?.();
  const size = display?.size;
  const logicalWidth = Number.isFinite(size?.width) ? size.width : 0;
  const logicalHeight = Number.isFinite(size?.height) ? size.height : 0;
  if (logicalWidth <= 0 || logicalHeight <= 0) {
    throw new Error("Unable to resolve the primary display size for OS computer use.");
  }
  return {
    logicalWidth,
    logicalHeight,
    scaleFactor: Number.isFinite(display?.scaleFactor) ? display.scaleFactor : 1,
  };
}

async function loadNut() {
  try {
    return await import("@nut-tree-fork/nut-js");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `OS computer use is unavailable: failed to load @nut-tree-fork/nut-js (${detail}).`,
    );
  }
}
