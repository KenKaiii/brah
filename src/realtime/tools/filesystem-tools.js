import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { findFilesTool } from "./file-search.js";
import { resolveSandboxPath } from "./sandbox-path.js";

const DEFAULT_MAX_READ_BYTES = 60_000;
const MAX_READ_BYTES = 200_000;
const MAX_WRITE_BYTES = 1_000_000;

/**
 * Local filesystem tools (read/write/edit) for the realtime agent. Every path is
 * resolved inside a sandbox root so the model cannot read or mutate files
 * outside the workspace. Expected failures are returned as discriminated result
 * objects; only programmer errors throw.
 *
 * @param {string} name Tool name.
 * @param {object} args Tool arguments from the model.
 * @param {{ rootPath?: string, platform?: string, execFileImpl?: Function }} [options] Sandbox configuration.
 * @returns {Promise<object|null>} Result for a filesystem tool, or null otherwise.
 */
export async function executeFileSystemTool(name, args = {}, options = {}) {
  switch (name) {
    case "read_file":
      return readFileTool(args, options);
    case "write_file":
      return writeFileTool(args, options);
    case "edit_file":
      return editFileTool(args, options);
    case "find_files":
      return findFilesTool(args, options);
    default:
      return null;
  }
}

async function readFileTool(args, options) {
  if (!isRecord(args)) {
    return invalidArguments("Arguments must be an object.");
  }
  const resolved = await resolveSandboxPath(args.path, options);
  if (!resolved.ok) {
    return invalidArguments(resolved.message);
  }
  const maxBytes = clampInteger(args.maxBytes, DEFAULT_MAX_READ_BYTES, 1, MAX_READ_BYTES);

  try {
    const info = await stat(resolved.value);
    if (info.isDirectory()) {
      return errorResult(`${args.path} is a directory, not a file.`);
    }
    const buffer = await readFile(resolved.value);
    const truncated = buffer.byteLength > maxBytes;
    return {
      status: "read",
      path: resolved.relative,
      bytes: buffer.byteLength,
      truncated,
      content: buffer.toString("utf8", 0, Math.min(buffer.byteLength, maxBytes)),
    };
  } catch (error) {
    return fileSystemError(error, args.path);
  }
}

async function writeFileTool(args, options) {
  if (!isRecord(args) || typeof args.content !== "string") {
    return invalidArguments("content must be a string.");
  }
  const resolved = await resolveSandboxPath(args.path, options);
  if (!resolved.ok) {
    return invalidArguments(resolved.message);
  }
  if (Buffer.byteLength(args.content, "utf8") > MAX_WRITE_BYTES) {
    return invalidArguments(`content exceeds the ${MAX_WRITE_BYTES} byte write limit.`);
  }

  try {
    const existed = await pathExists(resolved.value);
    await mkdir(path.dirname(resolved.value), { recursive: true });
    await writeFile(resolved.value, args.content, "utf8");
    return {
      status: existed ? "overwritten" : "created",
      path: resolved.relative,
      bytes: Buffer.byteLength(args.content, "utf8"),
      message: existed ? "File overwritten." : "File created.",
    };
  } catch (error) {
    return fileSystemError(error, args.path);
  }
}

async function editFileTool(args, options) {
  if (!isRecord(args) || typeof args.oldText !== "string" || typeof args.newText !== "string") {
    return invalidArguments("oldText and newText must be strings.");
  }
  if (args.oldText === "") {
    return invalidArguments("oldText must be a non-empty string.");
  }
  const resolved = await resolveSandboxPath(args.path, options);
  if (!resolved.ok) {
    return invalidArguments(resolved.message);
  }
  const replaceAll = args.replaceAll === true;

  try {
    const info = await stat(resolved.value);
    if (info.isDirectory()) {
      return errorResult(`${args.path} is a directory, not a file.`);
    }
    const original = await readFile(resolved.value, "utf8");
    const occurrences = countOccurrences(original, args.oldText);
    if (occurrences === 0) {
      return errorResult("oldText was not found in the file.");
    }
    if (occurrences > 1 && !replaceAll) {
      return errorResult(
        `oldText matched ${occurrences} times; pass replaceAll true or add more surrounding context.`,
      );
    }
    const updated = replaceAll
      ? original.split(args.oldText).join(args.newText)
      : original.replace(args.oldText, args.newText);
    await writeFile(resolved.value, updated, "utf8");
    return {
      status: "edited",
      path: resolved.relative,
      replacements: replaceAll ? occurrences : 1,
      message: `Replaced ${replaceAll ? occurrences : 1} occurrence(s).`,
    };
  } catch (error) {
    return fileSystemError(error, args.path);
  }
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

async function pathExists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function fileSystemError(error, requestedPath) {
  if (error?.code === "ENOENT") {
    return errorResult(`${requestedPath} was not found.`);
  }
  if (error?.code === "EACCES") {
    return errorResult(`Permission denied for ${requestedPath}.`);
  }
  if (error?.code === "EISDIR") {
    return errorResult(`${requestedPath} is a directory, not a file.`);
  }
  return errorResult(error instanceof Error ? error.message : "Filesystem operation failed.");
}

function clampInteger(value, fallback, minimum, maximum) {
  if (!Number.isInteger(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, value));
}

function invalidArguments(message) {
  return { status: "invalid_arguments", message };
}

function errorResult(message) {
  return { status: "error", message };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
