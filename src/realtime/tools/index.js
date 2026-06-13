import { executeComputerUseTool } from "./computer-use-tools.js";
import { executeFileSystemTool } from "./filesystem-tools.js";
import { executePlannerTool } from "./planner-tools.js";
import { executeScreenshotTool } from "./screenshot-tools.js";
import { executeSessionTool } from "./session-tools.js";
import { getRealtimeToolDefinitions } from "./tool-schemas.js";
import { executeWebTool } from "./web-tools.js";

export { getRealtimeToolDefinitions };

export async function executeRealtimeTool(name, args = {}, options = {}) {
  const plannerResult = await executePlannerTool(name, args, options.planner);
  if (plannerResult) {
    return plannerResult;
  }

  const webResult = await executeWebTool(name, args);
  if (webResult) {
    return webResult;
  }

  const fileSystemResult = await executeFileSystemTool(name, args, options.fileSystem);
  if (fileSystemResult) {
    return fileSystemResult;
  }

  const screenshotResult = await executeScreenshotTool(name, args, options.screenshot);
  if (screenshotResult) {
    return screenshotResult;
  }

  const computerResult = await executeComputerUseTool(name, args, options.computerUse);
  if (computerResult) {
    return computerResult;
  }

  const sessionResult = await executeSessionTool(name, args, options.session);
  if (sessionResult) {
    return sessionResult;
  }

  return {
    status: "error",
    message: `Unknown realtime tool: ${name}`,
  };
}
