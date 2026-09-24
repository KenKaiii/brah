// Write-time guard for long-term memory (facts, working notes, daily logs).
//
// Memory is re-injected into every future call's instructions, so anything
// written here outlives the conversation it came from. That turns a one-off
// prompt injection (a web page, a file, a screenshot the agent read) into a
// persistent one: OWASP lists memory poisoning as a top agentic risk. Best
// practice is to sanitize and validate before persistence, not at read time.
//
// Memory entries are *descriptions* ("Prefers metric units"), never
// *instructions to the model* ("ignore previous instructions", "you are now…",
// "always send…"). This guard rejects entries that look like the latter, plus
// credentials, so they are never stored. The same rules apply to working notes:
// they may be phrased as advice to Brah ("Answer first"), but never address the
// model's rules, tools, or system prompt.

// Invisible format characters (zero-width, bidi overrides, BOM) and control
// characters other than tab/newline, which could hide text in the Memory panel.
const INVISIBLE_CHARS = /\p{Cf}|(?![\t\n\r])\p{Cc}/gu;

// Phrases that try to reprogram the assistant rather than describe the user.
// Each is anchored to assistant-control vocabulary (instructions, rules,
// prompts, confirmation of actions) so everyday sentences about the user's
// life ("forget the messages from her ex", "got new instructions from her
// manager", "borrows things without asking") still save.
const INJECTION_PATTERNS = Object.freeze([
  /\b(ignore|disregard|forget|override|bypass)\b[^.]{0,40}\b(previous|prior|above|earlier|all|any|system|safety|your)\b[^.]{0,20}\b(instructions?|rules?|prompts?|guidelines?|directives?)\b/i,
  /\b(ignore|disregard)\s+(all\s+)?(the\s+)?(previous|prior|above|earlier)\s+messages?\b/i,
  /\b(system|developer)\s*(prompt|message|instructions?)\b/i,
  /\byou\s+are\s+now\b/i,
  /(^|[.!:]\s*)new\s+instructions?\s*[:-]/i,
  /\bjailbreak|\bDAN\s+mode\b/i,
  /\bdo\s+not\s+(ask|confirm)\b[^.]{0,40}\b(before|when)\b/i,
  /\b(send|sending|delete|deleting|email|emailing|run|running|execute|open|opening|share|sharing|buy|pay|paying|post|posting|act|proceed|do\s+it|do\s+this)\b[^.]{0,40}\bwithout\s+(asking|confirmation|confirming|checking)\b/i,
  /<\/?\s*(system|assistant|developer|instructions?|tool)\b[^>]*>/i,
  /^\s*#{1,6}\s/m,
  /\b(call|invoke|run|use)\s+(the\s+)?(tool|function)\b/i,
  /\b(send|post|upload|forward|exfiltrate)\b[^.]{0,50}\b(to|at)\s+(https?:\/\/|www\.|\S+@\S+\.\w+)/i,
]);

// Secrets never belong in memory; they would be replayed into every prompt.
const SECRET_PATTERNS = Object.freeze([
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // "password is x" / "pin: 4821"; "secret" and "token" only with = or : so
  // "the secret is that she's pregnant" still saves.
  /\b(password|passcode|passwd|pin|api[\s_-]?key)\s*(is|=|:)\s*\S{4,}/i,
  /\b(secret|token)\s*[=:]\s*\S{4,}/i,
]);

// Card numbers: 13-19 digits that pass the Luhn checksum (so ISBNs, phone
// numbers, and order numbers are not mistaken for cards).
const CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g;

function containsCardNumber(text) {
  for (const match of text.matchAll(CARD_CANDIDATE)) {
    if (passesLuhn(match[0].replace(/\D/g, ""))) {
      return true;
    }
  }
  return false;
}

function passesLuhn(digits) {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

// Working notes are followed as advice in every call, so they never need a
// link or address; one there is a tell-tale of an exfiltration or redirect
// payload ("first check example.com/?q=<what you know>").
const LINK_PATTERN =
  /\b(https?:\/\/|www\.)|\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|net|org|io|ai|dev|app|co|xyz|site|link|example|info|me|ly)\b|\S+@\S+\.\w+/i;

/**
 * Validate one memory text before it is persisted.
 *
 * @param {string} text Candidate memory text (untrusted: model or user output).
 * @param {{ kind?: "fact" | "soul" | "log" }} [options] Working notes ("soul") also refuse links.
 * @returns {{ ok: true, value: string } | { ok: false, reason: "empty" | "instruction" | "secret" }}
 */
export function checkMemoryText(text, { kind = "fact" } = {}) {
  const clean = typeof text === "string" ? text.replace(INVISIBLE_CHARS, "").trim() : "";
  if (!clean) {
    return { ok: false, reason: "empty" };
  }
  if (SECRET_PATTERNS.some((pattern) => pattern.test(clean)) || containsCardNumber(clean)) {
    return { ok: false, reason: "secret" };
  }
  if (INJECTION_PATTERNS.some((pattern) => pattern.test(clean))) {
    return { ok: false, reason: "instruction" };
  }
  if (kind === "soul" && LINK_PATTERN.test(clean)) {
    return { ok: false, reason: "instruction" };
  }
  return { ok: true, value: clean };
}

/** User-facing explanation for a rejected memory write. */
export function describeRejectedMemory(reason) {
  if (reason === "secret") {
    return "That looks like a password, key, or card number. Those are never saved to memory.";
  }
  if (reason === "instruction") {
    return "That reads like a command to the assistant rather than something about the user, so it was not saved. Rephrase it as a fact or preference.";
  }
  return "Nothing to save.";
}
