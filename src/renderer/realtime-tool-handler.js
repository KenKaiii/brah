export function getRealtimeToolCall(event) {
  if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
    // A barge-in (turn_detected) cancels the response mid-stream and the
    // function call comes back `incomplete` with truncated/empty arguments.
    // Executing it would run a tool with garbage args, so skip it. The
    // authoritative finalized item (with status) is on output_item.done, so we
    // dispatch from here rather than response.function_call_arguments.done.
    if (event.item.status === "incomplete") {
      return null;
    }
    return normalizeToolCall({
      callId: event.item.call_id,
      name: event.item.name,
      rawArguments: event.item.arguments,
    });
  }
  return null;
}

export function parseToolArguments(rawArguments) {
  if (typeof rawArguments !== "string" || !rawArguments.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(rawArguments);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function createRealtimeToolHandler({
  executeTool,
  sendEvent,
  setMode,
  setStatus,
  onEndCall,
  onToolStart,
  onToolEnd,
}) {
  const handledToolCallIds = new Set();

  return {
    reset() {
      handledToolCallIds.clear();
    },
    async handleEvent(event) {
      const toolCall = getRealtimeToolCall(event);
      if (!toolCall) {
        return false;
      }
      if (handledToolCallIds.has(toolCall.callId)) {
        return true;
      }
      handledToolCallIds.add(toolCall.callId);
      setStatus(formatToolStatus(toolCall.name));
      setMode("thinking");

      if (toolCall.name === "end_call") {
        // Ending the call is a renderer-side action (it owns the WebRTC peer).
        // Acknowledge the tool call without requesting a new response so the
        // model's goodbye finishes, then signal the host to hang up.
        sendRealtimeToolOutput(
          sendEvent,
          toolCall.callId,
          { status: "call_ended", message: "Ending the call." },
          { createResponse: false },
        );
        await onEndCall?.(toolCall.arguments);
        return true;
      }

      onToolStart?.(toolCall.name);
      let result;
      try {
        result = await executeToolSafely(executeTool, toolCall.name, toolCall.arguments);
      } finally {
        onToolEnd?.(toolCall.name);
      }
      if (isRecord(result?.realtimeInput)) {
        sendRealtimeToolOutput(sendEvent, toolCall.callId, createRealtimeImageToolOutput(result), {
          createResponse: false,
        });
        sendRealtimeImageResponse(sendEvent, result);
      } else {
        sendRealtimeToolOutput(sendEvent, toolCall.callId, result);
      }
      return true;
    },
  };
}

export function sendRealtimeToolOutput(sendEvent, callId, result, options = {}) {
  sendEvent({
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify(result),
    },
  });
  if (options.createResponse !== false) {
    sendEvent({ type: "response.create" });
  }
}

export function sendRealtimeImageResponse(sendEvent, result) {
  sendEvent({
    type: "response.create",
    response: {
      output_modalities: ["audio"],
      input: [result.realtimeInput],
      instructions:
        "Analyze the attached screenshot now and answer Ken directly. Do not say you are waiting for a screen read; the image is attached to this response input.",
    },
  });
}

export function createRealtimeImageToolOutput(result) {
  const { realtimeInput: _realtimeInput, ...safeResult } = result;
  return {
    ...safeResult,
    message:
      "Screenshot captured and attached to the Realtime conversation. Use the attached image to answer Ken's screen question.",
  };
}

export function formatToolStatus(name) {
  switch (name) {
    case "web_search":
      return "Searching…";
    case "web_fetch":
      return "Reading…";
    case "list_screenshot_sources":
      return "Listing sources…";
    case "take_screenshot":
      return "Taking screenshot…";
    case "analyze_screen":
      return "Reading screen…";
    case "computer_use_task":
      return "Using computer…";
    case "end_call":
      return "Ending call…";
    case "add_task":
    case "list_tasks":
    case "delete_task":
    case "update_task_status":
      return "Using tasks…";
    case "add_calendar_item":
    case "list_calendar_items":
    case "delete_calendar_item":
      return "Using calendar…";
    case "remember":
      return "Remembering…";
    case "forget":
      return "Forgetting…";
    case "list_facts":
    case "update_fact":
    case "recall_memory":
      return "Using memory…";
    case "daily_log":
      return "Journaling…";
    default:
      return "Using tool…";
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeToolCall({ callId, name, rawArguments }) {
  if (typeof callId !== "string" || !callId || typeof name !== "string" || !name) {
    return null;
  }
  return {
    callId,
    name,
    arguments: parseToolArguments(rawArguments),
  };
}

async function executeToolSafely(executeTool, name, args) {
  try {
    return await executeTool(name, args);
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Tool execution failed.",
    };
  }
}
