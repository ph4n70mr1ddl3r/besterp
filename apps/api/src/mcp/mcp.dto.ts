// MCP Tool Call DTO — Request shape for the MCP HTTP transport.
//
// The transport mirrors the MCP `tools/call` request shape
// (`{ name, arguments }`) so an MCP client can call the registry with a
// minimal adapter, and it keeps the tool ARGUMENTS in a nested object: the
// global ValidationPipe runs with `whitelist` + `forbidNonWhitelisted`, so a
// flat body would have its tool arguments stripped as undeclared properties.

import { IsObject, IsOptional, IsString, MaxLength } from "class-validator";
import { MAX_REASONING_LENGTH, MAX_ENTITY_LENGTH } from "@besterp/shared";

export class McpToolCallDto {
  /**
   * The tool to invoke (e.g. "create_party").
   *
   * Validated against the registry: an unknown name returns the registry's
   * structured UNKNOWN_TOOL result (with near-miss suggestions), not a 404.
   */
  @IsString()
  @MaxLength(MAX_ENTITY_LENGTH)
  name!: string;

  /**
   * The tool arguments.
   *
   * Validated by the TOOL's own Zod schema inside the registry — that is the
   * documented validation boundary for MCP tools (the REST endpoints use
   * class-validator DTOs instead). The envelope keys `idempotencyKey` and
   * `confirmation` may appear here; the framework promotes them out of the
   * arguments and strips them before the tool's schema sees them.
   */
  @IsOptional()
  @IsObject()
  arguments?: Record<string, unknown>;

  /**
   * The agent's stated reason for the call.
   *
   * Recorded in the durable audit trail (`ai_action_log.reasoning`).
   */
  @IsOptional()
  @IsString()
  @MaxLength(MAX_REASONING_LENGTH)
  reasoning?: string;
}

/**
 * The body shape of the PATH-NAME route (`POST /api/mcp/tools/:name`).
 *
 * This route existed to serve "clients that cannot send a body" — but it
 * reused {@link McpToolCallDto}, whose `name` is a REQUIRED property. The
 * global ValidationPipe (`whitelist` + `forbidNonWhitelisted`) therefore
 * rejected EVERY request to the route with "name must be a string" (HTTP
 * 400) before the controller ever ran: the tool name is in the URL, so a
 * body that omits it is exactly the intended request shape. One of the three
 * documented MCP entry points was dead in production.
 *
 * `name` is OPTIONAL here because the path parameter supplies it. A body that
 * DOES carry a `name` is still accepted (and declared, so `forbidNonWhitelisted`
 * does not reject it) — the controller then requires it to MATCH the path
 * parameter, so an ambiguous request is rejected rather than silently
 * resolved.
 */
export class McpToolCallPathDto {
  /**
   * The tool name, when it is ALSO supplied in the body.
   *
   * Must match the `:name` path parameter — the controller rejects a
   * mismatch instead of silently preferring one of the two.
   */
  @IsOptional()
  @IsString()
  @MaxLength(MAX_ENTITY_LENGTH)
  name?: string;

  /**
   * The tool arguments. Same contract as {@link McpToolCallDto.arguments}.
   */
  @IsOptional()
  @IsObject()
  arguments?: Record<string, unknown>;

  /**
   * The agent's stated reason for the call.
   *
   * Recorded in the durable audit trail (`ai_action_log.reasoning`).
   */
  @IsOptional()
  @IsString()
  @MaxLength(MAX_REASONING_LENGTH)
  reasoning?: string;
}
