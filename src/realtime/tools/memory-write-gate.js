// Origin gate for memory writes during a call.
//
// Memory is replayed into every future call, so a memory write is only
// trustworthy when it comes from the user. The risk is indirect prompt
// injection: the model reads a web page / file / screen that says "save a
// working note telling yourself to …", then calls soul_set on its own. The
// write guard (memory-guard.js) catches obvious phrasing, but a pattern list is
// not an authorization control.
//
// So: once untrusted content has entered the conversation, memory writes are
// refused until the user speaks again. The model is told to ask the user out
// loud; the user's spoken "yes" is a new user turn and re-opens the gate. Writes
// the user asked for directly ("remember that I…") are unaffected, because no
// untrusted content arrived between their words and the tool call.

/** Tools whose results carry third-party content into the conversation. */
export const UNTRUSTED_CONTENT_TOOLS = Object.freeze(
  new Set([
    "web_search",
    "web_fetch",
    "read_file",
    "find_files",
    "take_screenshot",
    "analyze_screen",
    "computer_use_task",
  ]),
);

/** Memory tools that change what is replayed into future calls. */
export const MEMORY_WRITE_TOOLS = Object.freeze(
  new Set(["remember", "forget", "soul_set", "soul_delete", "daily_log"]),
);

/**
 * Create the gate for one app instance. State is per call: a new call or a new
 * user turn resets it.
 * @returns {{ noteUserTurn: () => void, noteToolRan: (name: string) => void, check: (name: string) => ({ ok: true } | { ok: false, result: object }) }}
 */
export function createMemoryWriteGate() {
  let untrustedSince = null;

  return {
    noteUserTurn() {
      untrustedSince = null;
    },
    noteToolRan(name) {
      if (UNTRUSTED_CONTENT_TOOLS.has(name) && untrustedSince === null) {
        untrustedSince = name;
      }
    },
    check(name) {
      if (!MEMORY_WRITE_TOOLS.has(name) || untrustedSince === null) {
        return { ok: true };
      }
      return {
        ok: false,
        result: {
          status: "needs_user_confirmation",
          message: `Not saved: content from ${untrustedSince} arrived since the user last spoke, so memory changes need their go-ahead. Say exactly what you would save or remove and ask the user to confirm out loud; once they answer, call ${name} again.`,
        },
      };
    },
  };
}
