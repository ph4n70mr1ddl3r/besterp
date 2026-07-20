// MCP Module — Integrates the MCP Tool Server into NestJS.
//
// This module:
// 1. Creates the ToolRegistry and registers all tools
// 2. Sets up the global middleware pipeline (error handler, idempotency, audit)
// 3. Provides an MCP server adapter that translates MCP protocol calls → registry
// 4. Injects NestJS domain services into tool context via the services map
//
// Auth: MCP tool calls require a valid JWT with tenantId. The MCP transport
// adapter validates the token and passes the tenant context to buildContext().
//
// The MCP server can be exposed via:
// - stdio transport (for local CLI agents)
// - HTTP/SSE transport (for remote agents) — future

import {
  DynamicModule,
  Injectable,
  Logger,
  OnModuleInit,
} from "@nestjs/common";
import { validateTenantIdEnhanced } from "@besterp/database";
import { InvalidTypeValueError, MAX_USER_ID_LENGTH, MAX_IDEMPOTENCY_KEY_LENGTH, SAFE_IDEMPOTENCY_KEY, MAX_AGENT_ID_LENGTH, MAX_CONVERSATION_ID_LENGTH, MAX_REASONING_LENGTH, stripHtmlTags, sanitizeForLogOutput } from "@besterp/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { PartyService } from "../modules/core/party/party.service.js";
import { PartyModule } from "../modules/core/party/party.module.js";
import {
  ToolRegistry,
  errorHandlerMiddleware,
  idempotencyMiddleware,
  auditLogMiddleware,
} from "@besterp/mcp-tools";
import { registerPartyTools } from "./tools/party-tools.js";
import { registerDiscoveryTools } from "./tools/discovery-tools.js";

export const TOOL_REGISTRY = "TOOL_REGISTRY";

@Injectable()
export class McpModule implements OnModuleInit {
  private readonly logger = new Logger(McpModule.name);
  private readonly registry = new ToolRegistry();

  constructor(
    private readonly prisma: PrismaService,
    private readonly partyService: PartyService,
  ) {}

  onModuleInit() {
    // ─── Register global middlewares (outermost first) ──────────
    // Order matters: error handler wraps everything, then audit, then idempotency.
    // Audit MUST run before idempotency so that idempotent replays and
    // REQUEST_IN_PROGRESS responses are still recorded in the audit log.
    // NOTE: Middleware uses the admin client (this.prisma) intentionally:
    //   - Audit logs must be writable cross-tenant (bypass RLS)
    //   - Idempotency records need cross-tenant visibility
    this.registry.addGlobalMiddleware(errorHandlerMiddleware);
    this.registry.addGlobalMiddleware(auditLogMiddleware(this.prisma.admin));
    this.registry.addGlobalMiddleware(idempotencyMiddleware(this.prisma.admin));

    // ─── Register tools ────────────────────────────────────────
    registerPartyTools(this.registry);
    registerDiscoveryTools(this.registry, this.prisma.admin);

    this.logger.log(
      `MCP Tool Server initialized with ${this.registry.names.length} tools: ` +
      this.registry.names.join(", ")
    );
  }

  /**
   * Build a ToolContext with injected services for a given request.
   * Called by the MCP transport adapter after validating JWT.
   */
  buildContext(overrides: {
    tenantId: string;
    userId: string;
    agentId?: string;
    conversationId?: string;
    idempotencyKey?: string;
    reasoning?: string;
  }) {
    // Validate tenant ID format before building context. This catches invalid
    // tenant IDs from forged JWT tokens before any database operations.
    // Trim before validation so whitespace-padded values are validated against
    // their canonical form and stored trimmed.
    if (typeof overrides.tenantId !== "string") {
      throw new InvalidTypeValueError(
        "McpModule.buildContext: tenantId must be a string.",
        { context: { field: "tenantId", receivedType: typeof overrides.tenantId } }
      );
    }
    let tenantId = overrides.tenantId.trim();
    if (tenantId.length === 0) {
      throw new InvalidTypeValueError(
        "McpModule.buildContext: tenantId must not be empty or whitespace-only.",
        { context: { field: "tenantId", receivedType: typeof overrides.tenantId } }
      );
    }
    tenantId = validateTenantIdEnhanced(tenantId);

    // Validate userId — prevents null/empty user IDs in audit logs.
    if (typeof overrides.userId !== "string") {
      throw new InvalidTypeValueError(
        "McpModule.buildContext: userId must be a string.",
        { context: { field: "userId", receivedType: typeof overrides.userId } }
      );
    }
    let userId = overrides.userId;
    if (userId.trim().length === 0) {
      throw new InvalidTypeValueError(
        "McpModule.buildContext: userId must not be empty or whitespace-only.",
        { context: { field: "userId" } }
      );
    }
    userId = userId.trim();
    if (userId.length > MAX_USER_ID_LENGTH) {
      throw new InvalidTypeValueError(
        `McpModule.buildContext: userId is too long (${userId.length} chars, max ${MAX_USER_ID_LENGTH}).`,
        { context: { field: "userId", length: userId.length, maxLength: MAX_USER_ID_LENGTH } }
      );
    }
    // `userId` is attacker-influenced and persisted verbatim to the cross-tenant
    // `ai_action_log` durable sink (via auditLogMiddleware). Strip HTML/script
    // payloads (stored-XSS if ever rendered) and sanitize connection-string /
    // secret shapes before they reach the durable row — matching the defense
    // already applied to `reasoning` downstream. `agentId`/`conversationId`
    // below share the same durable sink and get the same treatment.
    userId = sanitizeForLogOutput(stripHtmlTags(userId));

    // Validate and normalise optional string fields — trim whitespace and
    // enforce length limits. We store the TRIMMED values so that downstream
    // code (audit logs, idempotency records) never sees padded strings.
    // Empty strings are normalised to undefined to keep data consistent.
    const idempotencyKey = validateOptionalField("idempotencyKey", overrides.idempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH);
    // Reject keys with control characters or non-ASCII bytes at the auth
    // boundary rather than letting them pass through to the idempotency
    // middleware, which would silently treat an unsafe key as a no-op
    // (skipping idempotency entirely) with no error. That asymmetry hid a
    // caller bug and silently disabled dedup. The same charset rule is applied
    // by the middleware and tool registry; enforcing it here keeps the three
    // boundaries consistent — a bad key surfaces as a structured 422 at the
    // entry point, not as a silent behavior change mid-pipeline.
    if (idempotencyKey !== undefined && !SAFE_IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new InvalidTypeValueError(
        "McpModule.buildContext: idempotencyKey must contain only printable ASCII characters.",
        { context: { field: "idempotencyKey" } }
      );
    }
    const agentId = validateOptionalField("agentId", overrides.agentId, MAX_AGENT_ID_LENGTH);
    const conversationId = validateOptionalField("conversationId", overrides.conversationId, MAX_CONVERSATION_ID_LENGTH);
    // reasoning validates identically to the other optional string fields, so
    // delegate to validateOptionalField instead of a bespoke duplicate.
    const reasoning = validateOptionalField("reasoning", overrides.reasoning, MAX_REASONING_LENGTH);
    // These identity/context fields are persisted to the cross-tenant
    // `ai_action_log` durable sink (via auditLogMiddleware). Strip HTML/script
    // payloads and sanitize connection-string / secret shapes at the boundary so
    // they cannot reach the durable row verbatim — mirroring the `userId`
    // treatment above and the downstream `reasoning` sanitization. `reasoning`
    // already runs through sanitizeForLogOutput in audit-log; the extra
    // stripHtmlTags here closes the XSS path for all four fields uniformly.
    const safeAgentId = agentId !== undefined ? sanitizeForLogOutput(stripHtmlTags(agentId)) : undefined;
    const safeConversationId = conversationId !== undefined ? sanitizeForLogOutput(stripHtmlTags(conversationId)) : undefined;
    const safeReasoning = reasoning !== undefined ? stripHtmlTags(reasoning) : undefined;

    return {
      tenantId,
      userId,
      agentId: safeAgentId,
      conversationId: safeConversationId,
      idempotencyKey,
      reasoning: safeReasoning,
      services: {
        partyService: this.partyService,
      },
    };
  }

  /**
   * Get the tool registry.
   */
  getRegistry(): ToolRegistry {
    return this.registry;
  }

  static forRoot(): DynamicModule {
    return {
      module: McpModule,
      imports: [PrismaModule, PartyModule],
      providers: [
        // McpModule is @Injectable — listed as a provider so NestJS injects
        // PrismaService + PartyService via constructor DI. The factory below
        // exposes the registry for injection elsewhere.
        McpModule,
        {
          provide: TOOL_REGISTRY,
          useFactory: (mcpModule: McpModule) => mcpModule.getRegistry(),
          inject: [McpModule],
        },
      ],
      exports: [TOOL_REGISTRY, McpModule],
    };
  }
}

/**
 * Validate and normalise an optional string field.
 * - Type-checks the value is a string (defensive — caller is TypeScript-typed
 *   but a forged or malformed request could pass a number, boolean, or
 *   object that would crash `value.trim()` with a TypeError, which would
 *   surface as an unstructured `INTERNAL_ERROR` rather than the
 *   structured `INVALID_TYPE_VALUE` the caller can recover from).
 * - Trims whitespace
 * - Rejects whitespace-only values
 * - Enforces max length
 * - Normalises empty strings to undefined
 *
 * Throws `InvalidTypeValueError` (a DomainError) so the MCP error handler
 * returns a structured response with `INVALID_TYPE_VALUE` and the field
 * name in `context`, instead of the generic `INTERNAL_ERROR` path.
 *
 * Used by McpModule.buildContext for agentId, conversationId, idempotencyKey.
 */
function validateOptionalField(
  fieldName: string,
  value: string | undefined | null,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  // Type guard: must be a string. A non-string value (e.g. number, object)
  // would crash the .trim() call below with a TypeError.
  if (typeof value !== "string") {
    throw new InvalidTypeValueError(
      `McpModule.buildContext: ${fieldName} must be a string, received ${typeof value}.`,
      { context: { field: fieldName, receivedType: typeof value } }
    );
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    // Empty string (or whitespace-only) → normalise to undefined for
    // consistency. Distinguish truly empty from whitespace-only so callers
    // can reject intentional padding (e.g. "   ") while accepting omitted
    // values (e.g. "").
    if (value.length > 0) {
      throw new InvalidTypeValueError(
        `McpModule.buildContext: ${fieldName} cannot be whitespace-only.`,
        { context: { field: fieldName } }
      );
    }
    return undefined;
  }
  if (trimmed.length > maxLength) {
    throw new InvalidTypeValueError(
      `McpModule.buildContext: ${fieldName} is too long (${trimmed.length} chars, max ${maxLength}).`,
      { context: { field: fieldName, length: trimmed.length, maxLength } }
    );
  }
  return trimmed;
}
