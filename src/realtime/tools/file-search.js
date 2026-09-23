import { execFile } from "node:child_process";
import { opendir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  getSandboxRoot,
  isDeniedRelative,
  resolveRealPath,
  resolveSandboxPath,
  toDisplayPath,
} from "./sandbox-path.js";

const DEFAULT_MAX_RESULTS = 15;
const MAX_RESULTS = 50;
const SPOTLIGHT_TIMEOUT_MS = 10_000;
const SPOTLIGHT_MAX_CANDIDATES = 600;
const WALK_MAX_DEPTH = 7;
const WALK_MAX_ENTRIES = 40_000;
const WALK_TIME_BUDGET_MS = 4_000;
const kinds = Object.freeze(["any", "file", "folder"]);
// Bulky or system folders that are never what the user means by "my files".
const SKIPPED_DIRECTORY_NAMES = new Set([
  "node_modules",
  "Library",
  "AppData",
  "Applications",
  "__pycache__",
  "venv",
  ".venv",
  "dist",
  "build",
  "target",
  "Pods",
  "DerivedData",
]);

/**
 * find_files: locate files/folders by name words, extension, and recency inside
 * the sandbox. Uses Spotlight on macOS (fast, can also match file contents) and
 * a bounded directory walk elsewhere or when Spotlight has nothing.
 */
export async function findFilesTool(args, options = {}) {
  const parsed = parseArgs(args);
  if (!parsed.ok) {
    return { status: "invalid_arguments", message: parsed.message };
  }
  const criteria = parsed.value;
  const folder = await resolveSandboxPath(criteria.folder, options, { allowRoot: true });
  if (!folder.ok) {
    return { status: "invalid_arguments", message: folder.message };
  }
  try {
    const info = await stat(folder.value);
    if (!info.isDirectory()) {
      return { status: "error", message: `${criteria.folder} is a file, not a folder.` };
    }
  } catch {
    return {
      status: "error",
      message: `The folder ${criteria.folder} was not found. Try a folder like ~/Documents, ~/Downloads, or ~/Desktop, or leave folder out to search everywhere.`,
    };
  }

  const root = await resolveRealPath(getSandboxRoot(options));
  const startedAt = Date.now();
  const platform = options.platform ?? process.platform;
  let engine = "walk";
  let candidates = null;
  if (platform === "darwin") {
    candidates = await spotlightCandidates(
      folder.value,
      criteria,
      options.execFileImpl ?? execFile,
    );
    engine = "spotlight";
  }
  if (!candidates || (candidates.length === 0 && !criteria.searchContents)) {
    candidates = await walkCandidates(folder.value, criteria);
    engine = "walk";
  }

  const matches = [];
  for (const candidate of candidates.slice(0, SPOTLIGHT_MAX_CANDIDATES)) {
    const entry = await describeCandidate(candidate, root, criteria);
    if (entry) {
      matches.push(entry);
    }
  }
  matches.sort((a, b) => b.score - a.score || b.modifiedMs - a.modifiedMs);
  const results = matches
    .slice(0, criteria.maxResults)
    .map(({ score, modifiedMs, ...rest }) => rest);

  return {
    status: "found",
    engine,
    folder: toDisplayPath(folder.value),
    resultCount: results.length,
    totalMatches: matches.length,
    results,
    elapsedMs: Date.now() - startedAt,
    message:
      results.length > 0
        ? `Found ${matches.length} match(es), best first. Use a path with read_file to read it or open_file to open it for the user.`
        : criteria.searchContents || engine === "walk"
          ? "Nothing matched. Try fewer or different words, drop the extension or date filter, or search a different folder."
          : "Nothing matched by name. Try fewer words, or set searchContents true to also match text inside files.",
  };
}

function parseArgs(args) {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { ok: false, message: "Arguments must be an object." };
  }
  const query = typeof args.query === "string" ? args.query.trim().slice(0, 200) : "";
  const extension =
    typeof args.extension === "string"
      ? args.extension
          .trim()
          .replace(/^\*?\./, "")
          .toLowerCase()
      : "";
  if (extension && !/^[a-z0-9]{1,12}$/.test(extension)) {
    return { ok: false, message: "extension must be letters/digits only, like pdf or docx." };
  }
  const modifiedWithinDays =
    Number.isFinite(args.modifiedWithinDays) && args.modifiedWithinDays > 0
      ? Math.min(Math.ceil(args.modifiedWithinDays), 3650)
      : null;
  if (!query && !extension && !modifiedWithinDays) {
    return {
      ok: false,
      message: "Provide at least one of query, extension, or modifiedWithinDays.",
    };
  }
  const kind = args.kind === undefined ? "any" : args.kind;
  if (!kinds.includes(kind)) {
    return { ok: false, message: "kind must be one of any, file, or folder." };
  }
  return {
    ok: true,
    value: {
      query,
      tokens: tokenize(query),
      wildcard: /[*?]/.test(query) ? wildcardToRegExp(query) : null,
      extension,
      modifiedWithinDays,
      kind,
      searchContents: args.searchContents === true && Boolean(query),
      folder: typeof args.folder === "string" && args.folder.trim() ? args.folder : ".",
      maxResults: Number.isInteger(args.maxResults)
        ? Math.min(MAX_RESULTS, Math.max(1, args.maxResults))
        : DEFAULT_MAX_RESULTS,
    },
  };
}

// Words the user said, reduced to characters that are safe to embed in a
// Spotlight query string (no quotes, backslashes, or operators).
function tokenize(query) {
  return query
    .replace(/[*?]/g, " ")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 8);
}

function wildcardToRegExp(pattern) {
  const escaped = pattern
    .toLowerCase()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

export function buildSpotlightQuery(criteria) {
  const clauses = criteria.tokens.map((token) =>
    criteria.searchContents
      ? `(kMDItemFSName == "*${token}*"cd || kMDItemTextContent == "${token}*"cdw)`
      : `kMDItemFSName == "*${token}*"cd`,
  );
  if (criteria.extension) {
    clauses.push(`kMDItemFSName == "*.${criteria.extension}"c`);
  }
  if (criteria.modifiedWithinDays) {
    clauses.push(`kMDItemFSContentChangeDate >= $time.today(-${criteria.modifiedWithinDays})`);
  }
  if (criteria.kind === "folder") {
    clauses.push('kMDItemContentType == "public.folder"');
  }
  return clauses.join(" && ");
}

// Returns candidate absolute paths, or null when Spotlight is unavailable.
async function spotlightCandidates(folder, criteria, execFileImpl) {
  const query = buildSpotlightQuery(criteria);
  if (!query) {
    return null;
  }
  return new Promise((resolve) => {
    execFileImpl(
      "mdfind",
      ["-onlyin", folder, query],
      { timeout: SPOTLIGHT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(
          String(stdout)
            .split("\n")
            .filter((line) => line.startsWith("/"))
            .filter((line) => !isNoisePath(line)),
        );
      },
    );
  });
}

function isNoisePath(absolute) {
  const parts = absolute.split(path.sep);
  return parts.some(
    (part) => SKIPPED_DIRECTORY_NAMES.has(part) || part === ".git" || part === ".Trash",
  );
}

async function walkCandidates(folder, criteria) {
  const deadline = Date.now() + WALK_TIME_BUDGET_MS;
  const found = [];
  const queue = [{ dir: folder, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && visited < WALK_MAX_ENTRIES && Date.now() < deadline) {
    const { dir, depth } = queue.shift();
    let handle;
    try {
      handle = await opendir(dir);
    } catch {
      continue;
    }
    for await (const entry of handle) {
      visited += 1;
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) {
        continue;
      }
      const full = path.join(dir, entry.name);
      const isFolder = entry.isDirectory();
      if (nameMatches(entry.name, isFolder, criteria)) {
        found.push(full);
      }
      if (isFolder && depth < WALK_MAX_DEPTH && !SKIPPED_DIRECTORY_NAMES.has(entry.name)) {
        if (!entry.name.endsWith(".app")) {
          queue.push({ dir: full, depth: depth + 1 });
        }
      }
      if (visited >= WALK_MAX_ENTRIES) {
        break;
      }
    }
  }
  return found;
}

function nameMatches(name, isFolder, criteria) {
  if (criteria.kind === "file" && isFolder) return false;
  if (criteria.kind === "folder" && !isFolder) return false;
  const lower = name.toLowerCase();
  if (criteria.extension && !lower.endsWith(`.${criteria.extension}`)) return false;
  if (criteria.wildcard) return criteria.wildcard.test(lower);
  return criteria.tokens.every((token) => lower.includes(token));
}

// `root` is already symlink-resolved; resolving each candidate the same way
// keeps a symlinked hit from pointing outside the sandbox or at a secret.
async function describeCandidate(candidate, root, criteria) {
  let info;
  try {
    const real = await realpath(candidate);
    const relative = path.relative(root, real);
    if (relative.startsWith("..") || path.isAbsolute(relative) || isDeniedRelative(relative)) {
      return null;
    }
    info = await stat(real);
  } catch {
    return null;
  }
  const isFolder = info.isDirectory();
  const name = path.basename(candidate);
  if (criteria.kind === "file" && isFolder) return null;
  if (criteria.kind === "folder" && !isFolder) return null;
  if (criteria.extension && !name.toLowerCase().endsWith(`.${criteria.extension}`)) return null;
  if (
    criteria.wildcard &&
    !criteria.searchContents &&
    !criteria.wildcard.test(name.toLowerCase())
  ) {
    return null;
  }
  if (
    criteria.modifiedWithinDays &&
    Date.now() - info.mtimeMs > criteria.modifiedWithinDays * 86_400_000
  ) {
    return null;
  }
  return {
    path: toDisplayPath(candidate),
    name,
    kind: isFolder ? "folder" : "file",
    ...(isFolder ? {} : { sizeBytes: info.size }),
    modified: new Date(info.mtimeMs).toISOString(),
    score: scoreName(name, criteria),
    modifiedMs: info.mtimeMs,
  };
}

// Whole-name and name-prefix hits beat substring hits; content-only matches
// (name contains none of the words) rank last.
function scoreName(name, criteria) {
  if (criteria.tokens.length === 0) return 0;
  const lower = name.toLowerCase();
  const stem = lower.replace(/\.[^.]+$/, "");
  const phrase = criteria.tokens.join(" ");
  const normalizedStem = stem.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const normalizedName = lower.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (normalizedStem === phrase || normalizedName === phrase) return 4;
  if (normalizedStem.startsWith(phrase)) return 3;
  const hits = criteria.tokens.filter((token) => lower.includes(token)).length;
  return hits === criteria.tokens.length ? 2 : hits > 0 ? 1 : 0;
}
