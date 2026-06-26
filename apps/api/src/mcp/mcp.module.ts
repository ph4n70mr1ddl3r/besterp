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
import { InvalidTypeValueError, MAX_USER_ID_LENGTH, MAX_IDEMPOTENCY_KEY_LENGTH, MAX_AGENT_ID_LENGTH, MAX_CONVERSATION_ID_LENGTH, MAX_REASONING_LENGTH } from "@besterp/shared";
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
    const tenantId = overrides.tenantId.trim();
    validateTenantIdEnhanced(tenantId);

    // Validate userId — prevents null/empty user IDs in audit logs.
    let userId = overrides.userId;
    if (!userId || userId.trim().length === 0) {
      throw new InvalidTypeValueError(
        "McpModule.buildContext: userId is required and cannot be empty.",
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

    // Validate and normalise optional string fields — trim whitespace and
    // enforce length limits. We store the TRIMMED values so that downstream
    // code (audit logs, idempotency records) never sees padded strings.
    // Empty strings are normalised to undefined to keep data consistent.
    const idempotencyKey = validateOptionalField("idempotencyKey", overrides.idempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH);
    const agentId = validateOptionalField("agentId", overrides.agentId, MAX_AGENT_ID_LENGTH);
    const conversationId = validateOptionalField("conversationId", overrides.conversationId, MAX_CONVERSATION_ID_LENGTH);
    const reasoning = validateReasoningField(overrides.reasoning);

    return {
      tenantId,
      userId,
      agentId,
      conversationId,
      idempotencyKey,
      reasoning,
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
          provide: "TOOL_REGISTRY",
          useFactory: (mcpModule: McpModule) => mcpModule.getRegistry(),
          inject: [McpModule],
        },
      ],
      exports: ["TOOL_REGISTRY", McpModule],
    };
  }
}

/**
 * Validate the optional reasoning field — normalises whitespace-only
 * or empty values to undefined, but enforces max length to prevent oversized
 * audit log payloads. Consistent with validateOptionalField for other fields.
 */
function validateReasoningField(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new InvalidTypeValueError(
      `McpModule.buildContext: reasoning must be a string, received ${typeof value}.`,
      { context: { field: "reasoning", receivedType: typeof value } }
    );
  }
  if (value.length === 0) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidTypeValueError(
      "McpModule.buildContext: reasoning cannot be whitespace-only.",
      { context: { field: "reasoning" } }
    );
  }
  if (trimmed.length > MAX_REASONING_LENGTH) {
    throw new InvalidTypeValueError(
      `McpModule.buildContext: reasoning is too long (${trimmed.length} chars, max ${MAX_REASONING_LENGTH}).`,
      { context: { field: "reasoning", length: trimmed.length, maxLength: MAX_REASONING_LENGTH } }
    );
  }
  return trimmed;
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
  if (value.length === 0) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidTypeValueError(
      `McpModule.buildContext: ${fieldName} cannot be whitespace-only.`,
      { context: { field: fieldName } }
    );
  }
  if (trimmed.length > maxLength) {
    throw new InvalidTypeValueError(
      `McpModule.buildContext: ${fieldName} is too long (${trimmed.length} chars, max ${maxLength}).`,
      { context: { field: fieldName, length: trimmed.length, maxLength } }
    );
  }
  return trimmed;
}
