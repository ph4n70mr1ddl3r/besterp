// MCP injection tokens.
//
// The tokens live in their own module so that `mcp.module.ts` (which
// provides them) and `mcp.controller.ts` (which injects them) do not import
// each other: a circular import between them evaluated the module registry
// before its `const` was initialised, and the API failed to boot with
// "Cannot access 'TOOL_REGISTRY' before initialization".

/** The `ToolRegistry` instance that holds the registered MCP tools. */
export const TOOL_REGISTRY = "TOOL_REGISTRY";
