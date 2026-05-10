// Rich error formatting for MCP tool responses.
//
// AI agents need actionable errors they can reason about and recover from.
// Every error includes: code, message, suggested tools, and context.

export interface RichErrorContent {
  error: string;
  message: string;
  suggestedTools: string[];
  context: Record<string, unknown>;
}

/**
 * Format a rich, actionable error for AI agent consumption.
 *
 * @param code           - Machine-readable error code (e.g., "MISSING_SUBTYPE_DATA")
 * @param message        - Human-readable description of what went wrong
 * @param suggestedTools - Tools the agent should consider using next
 * @param context        - Additional structured context for debugging
 * @returns MCP-compatible error response object
 */
export function richError(
  code: string,
  message: string,
  suggestedTools: string[] = [],
  context: Record<string, unknown> = {}
) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: code, message, suggestedTools, context }),
      },
    ],
  };
}
