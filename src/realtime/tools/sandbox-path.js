import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Shared sandbox for every local-file tool: paths resolve inside a root (the
// user's home by default), symlinks may not escape it, and credential/shell
// locations are never reachable.

/**
 * @param {unknown} rawPath
 * @param {{ rootPath?: string }} [options]
 * @param {{ allowRoot?: boolean }} [flags] allowRoot lets a folder tool target the root itself.
 * @returns {Promise<{ ok: true, value: string, relative: string } | { ok: false, message: string }>}
 */
export async function resolveSandboxPath(rawPath, options, { allowRoot = false } = {}) {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return { ok: false, message: "path must be a non-empty string." };
  }
  const root = getSandboxRoot(options);
  const trimmed = rawPath.trim();
  const expanded = trimmed.startsWith("~") ? path.join(os.homedir(), trimmed.slice(1)) : trimmed;
  const absolute = path.resolve(root, expanded);
  const relative = path.relative(root, absolute);
  if ((relative === "" || relative === ".") && !allowRoot) {
    return { ok: false, message: "path must point to a file inside the workspace, not the root." };
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ok: false, message: "path must stay inside the workspace root." };
  }
  // Lexical checks above can be defeated by a symlink inside the workspace that
  // points outside it, so verify the real (symlink-resolved) location too. New
  // files may not exist yet, so resolve the nearest existing ancestor.
  let realRoot;
  let realTarget;
  try {
    realRoot = await resolveRealPath(root);
    realTarget = await resolveRealPath(absolute);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Failed to resolve path.",
    };
  }
  const realRelative = path.relative(realRoot, realTarget);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    return { ok: false, message: "path resolves through a symlink outside the workspace root." };
  }
  if (isDeniedRelative(realRelative) || isDeniedRelative(relative)) {
    return { ok: false, message: "path points to a protected location and is not accessible." };
  }
  return { ok: true, value: absolute, relative };
}

const DENIED_SEGMENTS = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".gpg",
  ".docker",
  ".kube",
  ".config",
  ".password-store",
  "Brah", // ~/Library/Application Support/Brah (app creds + db)
]);
const DENIED_BASENAMES = new Set([
  ".netrc",
  ".npmrc",
  ".git-credentials",
  ".bash_history",
  ".zsh_history",
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".bashrc",
  ".bash_profile",
  ".profile",
  ".env",
]);

/** @param {string} rel Path relative to the sandbox root. */
export function isDeniedRelative(rel) {
  const parts = rel.split(path.sep).filter(Boolean);
  if (parts.some((p) => DENIED_SEGMENTS.has(p))) return true;
  const base = parts.at(-1);
  if (base && DENIED_BASENAMES.has(base)) return true;
  if (base?.endsWith(".pem")) return true;
  return false;
}

// Resolves the real path of `target`, following symlinks. When `target` does not
// exist yet, it resolves the nearest existing ancestor and re-appends the
// not-yet-created suffix (which cannot itself be a symlink).
export async function resolveRealPath(target) {
  const missingSegments = [];
  let current = target;
  for (;;) {
    try {
      const real = await realpath(current);
      return missingSegments.length > 0 ? path.join(real, ...missingSegments) : real;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return target;
      }
      missingSegments.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** @param {{ rootPath?: string } | undefined} options */
export function getSandboxRoot(options) {
  const candidate = options?.rootPath;
  return typeof candidate === "string" && candidate.trim() ? path.resolve(candidate) : os.homedir();
}

// "~/Downloads/a.pdf" when inside the home folder, otherwise the absolute path.
export function toDisplayPath(absolute) {
  const home = os.homedir();
  const rel = path.relative(home, absolute);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? `~/${rel}` : absolute;
}
