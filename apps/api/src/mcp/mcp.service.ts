import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InvalidTypeValueError, MAX_USER_ID_LENGTH, MAX_IDEMPOTENCY_KEY_LENGTH, SAFE_IDEMPOTENCY_KEY, MAX_AGENT_ID_LENGTH, MAX_CONVERSATION_ID_LENGTH, MAX_REASONING_LENGTH, stripHtmlTags, sanitizeForLogOutput, TENANT_ID_PATTERN, validateTenantIdEnhancedForAuth, validateOptionalString } from "@besterp/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { PartyService } from "../modules/core/party/party.service.js";
import { SecurityService } from "../modules/core/security/security.service.js";
import {
  ToolRegistry,
  errorHandlerMiddleware,
  idempotencyMiddleware,
  auditLogMiddleware,
  confirmationGateMiddleware,
  type ToolContext,
} from "@besterp/mcp-tools";
import { registerPartyTools } from "./tools/party-tools.js";
import { registerDiscoveryTools } from "./tools/discovery-tools.js";
import { registerAgentTools } from "./tools/agent-tools.js";
import { registerProductTools } from "./tools/product-tools.js";

@Injectable()
export class McpService implements OnModuleInit {
  private readonly logger = new Logger(McpService.name);
  readonly registry = new ToolRegistry();

  constructor(
    private readonly prisma: PrismaService,
    private readonly partyService: PartyService,
    private readonly securityService: SecurityService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.registry.addGlobalMiddleware(errorHandlerMiddleware);
    this.registry.addGlobalMiddleware(auditLogMiddleware(this.prisma.admin));
    this.registry.addGlobalMiddleware(idempotencyMiddleware(this.prisma.admin));
    this.registry.addGlobalMiddleware(confirmationGateMiddleware(this.prisma.admin));

    registerPartyTools(this.registry);
    registerDiscoveryTools(this.registry, this.prisma.admin);
    registerAgentTools(this.registry);
    registerProductTools(this.registry);

    this.logger.log(
      `MCP Tool Server initialized with ${this.registry.names.length} tools: ` +
      this.registry.names.join(", ")
    );
  }

  /**
   * Build the MCP tool context from request overrides.
   *
   * Identity fields (userId, agentId, conversationId, idempotencyKey) are
   * charset-validated and returned raw so they stay usable for correlation
   * and idempotent dedup; sanitization runs at the durable-sink surfaces
   * (audit-log, idempotency). Content fields (reasoning) have HTML tags
   * stripped via stripHtmlTags and secrets/URLs redacted via
   * sanitizeForLogOutput. Whitespace trimmed, length caps enforced via shared constants.
   */
  buildContext(overrides: {
    tenantId: string;
    userId: string;
    agentId?: string;
    conversationId?: string;
    idempotencyKey?: string;
    reasoning?: string;
  }): ToolContext {
    const tenantId = this.validateTenantId(overrides.tenantId);
    const userId = this.validateUserId(overrides.userId);
    const idempotencyKey = this.validateIdempotencyKey(overrides.idempotencyKey);
    const { agentId, conversationId } = this.validateOptionalIds(overrides);
    const reasoning = this.validateReasoning(overrides.reasoning);

    return {
      tenantId,
      userId,
      agentId,
      conversationId,
      idempotencyKey,
      reasoning,
      services: {
        partyService: this.partyService,
        securityService: this.securityService,
      },
    };
  }

  private validateTenantId(value: string): string {
    return validateTenantIdEnhancedForAuth(value);
  }

  private validateUserId(value: string): string {
    if (typeof value !== "string") {
      throw new InvalidTypeValueError(
        "userId must be a string.",
        { context: { field: "userId", receivedType: typeof value } }
      );
    }
    const rawUserId = value.trim();
    if (rawUserId.length === 0) {
      throw new InvalidTypeValueError(
        "userId must not be empty or whitespace-only.",
        { context: { field: "userId" } }
      );
    }
    if (rawUserId.length > MAX_USER_ID_LENGTH) {
      throw new InvalidTypeValueError(
        `userId is too long (${rawUserId.length} chars, max ${MAX_USER_ID_LENGTH}).`,
        { context: { field: "userId", length: rawUserId.length, maxLength: MAX_USER_ID_LENGTH } }
      );
    }
    if (!TENANT_ID_PATTERN.test(rawUserId)) {
      throw new InvalidTypeValueError(
        "userId contains invalid characters. " +
          "User IDs may only contain alphanumeric characters, hyphens, and underscores.",
        { context: { field: "userId" } }
      );
    }
    // Return the raw trimmed userId (not sanitized) so downstream validators
    // (tool-registry.validateContextIdentity) can apply their own format check
    // on the same value. Sanitization happens at the output surfaces
    // (audit-log, idempotency) so the durable sinks never store a raw secret
    // while the identity fields remain usable for correlation and auditing.
    return rawUserId;
  }

  private validateIdempotencyKey(value: string | undefined): string | undefined {
    const raw = validateOptionalString("idempotencyKey", value, MAX_IDEMPOTENCY_KEY_LENGTH);
    if (raw !== undefined && !SAFE_IDEMPOTENCY_KEY.test(raw)) {
      throw new InvalidTypeValueError(
        "idempotencyKey must contain only printable ASCII characters.",
        { context: { field: "idempotencyKey" } }
      );
    }
    // Return the raw trimmed key verbatim. SAFE_IDEMPOTENCY_KEY already
    // restricts the key to printable ASCII (no CR/LF/log-injection), so the
    // value is log-safe by construction and must NOT be passed through
    // sanitizeForLogOutput/stripHtmlTags here: it is the dedup identity for
    // idempotency_record, and any transformation (redaction of mixed-case
    // token-shaped keys, HTML-tag stripping of permitted `<>/` chars) would
    // corrupt the key and collapse distinct requests onto the same record.
    return raw;
  }

  private validateOptionalIds(overrides: { agentId?: string; conversationId?: string }): { agentId: string | undefined; conversationId: string | undefined } {
    const agentId = validateOptionalString("agentId", overrides.agentId, MAX_AGENT_ID_LENGTH);
    const conversationId = validateOptionalString("conversationId", overrides.conversationId, MAX_CONVERSATION_ID_LENGTH);
    // Pattern validation for agentId and conversationId is handled by
    // ToolRegistry.validateContextIdentity (OPTIONAL_ID_PATTERN) at execution
    // time. buildContext intentionally does NOT re-apply a stricter pattern
    // here: the registry is the authoritative execution boundary and its
    // OPTIONAL_ID_PATTERN accommodates real-world identifiers (e.g. john.doe,
    // user+role) that TENANT_ID_PATTERN would reject. Applying a stricter
    // guard in buildContext would silently drop values the registry accepts,
    // producing inconsistent behaviour across construction vs. execution paths.
    // Length caps are still enforced here so oversized values never reach the
    // registry (the registry also checks length, but early fail is cheaper).
    return { agentId, conversationId };
  }

  private validateReasoning(value: string | undefined): string | undefined {
    const reasoning = validateOptionalString("reasoning", value, MAX_REASONING_LENGTH);
    return reasoning !== undefined ? sanitizeForLogOutput(stripHtmlTags(reasoning)) : undefined;
  }

  getRegistry(): ToolRegistry {
    return this.registry;
  }
}
