import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InvalidTypeValueError, MAX_USER_ID_LENGTH, MAX_IDEMPOTENCY_KEY_LENGTH, SAFE_IDEMPOTENCY_KEY, MAX_AGENT_ID_LENGTH, MAX_CONVERSATION_ID_LENGTH, MAX_REASONING_LENGTH, stripHtmlTags, sanitizeForLogOutput, TENANT_ID_PATTERN } from "@besterp/shared";
import { validateTenantIdEnhanced } from "@besterp/database";
import { PrismaService } from "../prisma/prisma.service.js";
import { PartyService } from "../modules/core/party/party.service.js";
import {
  ToolRegistry,
  errorHandlerMiddleware,
  idempotencyMiddleware,
  auditLogMiddleware,
} from "@besterp/mcp-tools";
import { registerPartyTools } from "./tools/party-tools.js";
import { registerDiscoveryTools } from "./tools/discovery-tools.js";

/**
 * Validate an optional string field: trim, reject non-string types, reject
 * whitespace-only input, enforce max length. Returns trimmed value or undefined.
 */
function validateOptionalField(
  fieldName: string,
  value: string | undefined | null,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new InvalidTypeValueError(
      `McpService.buildContext: ${fieldName} must be a string, received ${typeof value}.`,
      { context: { field: fieldName, receivedType: typeof value } }
    );
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    if (value.length > 0) {
      throw new InvalidTypeValueError(
        `McpService.buildContext: ${fieldName} cannot be whitespace-only.`,
        { context: { field: fieldName } }
      );
    }
    return undefined;
  }
  if (trimmed.length > maxLength) {
    throw new InvalidTypeValueError(
      `McpService.buildContext: ${fieldName} is too long (${trimmed.length} chars, max ${maxLength}).`,
      { context: { field: fieldName, length: trimmed.length, maxLength } }
    );
  }
  return trimmed;
}

@Injectable()
export class McpService implements OnModuleInit {
  private readonly logger = new Logger(McpService.name);
  readonly registry = new ToolRegistry();

  constructor(
    private readonly prisma: PrismaService,
    private readonly partyService: PartyService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.registry.addGlobalMiddleware(errorHandlerMiddleware);
    this.registry.addGlobalMiddleware(auditLogMiddleware(this.prisma.admin));
    this.registry.addGlobalMiddleware(idempotencyMiddleware(this.prisma.admin));

    registerPartyTools(this.registry);
    registerDiscoveryTools(this.registry, this.prisma.admin);

    this.logger.log(
      `MCP Tool Server initialized with ${this.registry.names.length} tools: ` +
      this.registry.names.join(", ")
    );
  }

  /**
   * Build the MCP tool context from request overrides.
   * 
   * All string inputs are validated at this boundary to prevent secret
   * leakage and XSS:
   * - Identity fields (userId, agentId, conversationId, idempotencyKey) are
   *   charset-validated and returned raw so they stay usable for correlation
   *   and idempotent dedup; sanitization runs at the durable-sink surfaces.
   * - Content fields (reasoning) have HTML tags stripped via stripHtmlTags
   *   and secrets/URLs redacted via sanitizeForLogOutput.
   * - Whitespace trimmed, length caps enforced via shared constants.
   * 
   * @param overrides - Context overrides including tenantId, userId, optional fields
   */
   buildContext(overrides: {
     tenantId: string;
     userId: string;
     agentId?: string;
     conversationId?: string;
     idempotencyKey?: string;
     reasoning?: string;
   }): {
     tenantId: string;
     userId: string;
     agentId?: string;
     conversationId?: string;
     idempotencyKey?: string;
     reasoning?: string;
     services: { partyService: PartyService };
   } {
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
      },
    };
  }

  private validateTenantId(value: string): string {
    return validateTenantIdEnhanced(value);
  }

  private validateUserId(value: string): string {
    if (typeof value !== "string") {
      throw new InvalidTypeValueError(
        "McpService.buildContext: userId must be a string.",
        { context: { field: "userId", receivedType: typeof value } }
      );
    }
    const rawUserId = value.trim();
    if (rawUserId.length === 0) {
      throw new InvalidTypeValueError(
        "McpService.buildContext: userId must not be empty or whitespace-only.",
        { context: { field: "userId" } }
      );
    }
    if (rawUserId.length > MAX_USER_ID_LENGTH) {
      throw new InvalidTypeValueError(
        `McpService.buildContext: userId is too long (${rawUserId.length} chars, max ${MAX_USER_ID_LENGTH}).`,
        { context: { field: "userId", length: rawUserId.length, maxLength: MAX_USER_ID_LENGTH } }
      );
    }
    if (!TENANT_ID_PATTERN.test(rawUserId)) {
      throw new InvalidTypeValueError(
        "McpService.buildContext: userId contains invalid characters. " +
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
    const raw = validateOptionalField("idempotencyKey", value, MAX_IDEMPOTENCY_KEY_LENGTH);
    if (raw !== undefined && !SAFE_IDEMPOTENCY_KEY.test(raw)) {
      throw new InvalidTypeValueError(
        "McpService.buildContext: idempotencyKey must contain only printable ASCII characters.",
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
    const agentId = validateOptionalField("agentId", overrides.agentId, MAX_AGENT_ID_LENGTH);
    const conversationId = validateOptionalField("conversationId", overrides.conversationId, MAX_CONVERSATION_ID_LENGTH);

    // Enforce charset at the auth boundary for agentId and conversationId,
    // matching the guard already applied to userId above. These fields are
    // persisted verbatim into durable sinks (ai_action_log, idempotency_record),
    // so invalid chars must be rejected before sanitization runs — a value
    // containing e.g. `;` or `<` would otherwise only be caught later at the
    // tool-registry execution boundary, leaving a defense-in-depth gap.
    if (agentId !== undefined && !TENANT_ID_PATTERN.test(agentId)) {
      throw new InvalidTypeValueError(
        "McpService.buildContext: agentId contains invalid characters. " +
          "Agent IDs may only contain alphanumeric characters, hyphens, and underscores.",
        { context: { field: "agentId" } }
      );
    }
    if (conversationId !== undefined && !TENANT_ID_PATTERN.test(conversationId)) {
      throw new InvalidTypeValueError(
        "McpService.buildContext: conversationId contains invalid characters. " +
          "Conversation IDs may only contain alphanumeric characters, hyphens, and underscores.",
        { context: { field: "conversationId" } }
      );
    }
    return { agentId, conversationId };
  }

  private validateReasoning(value: string | undefined): string | undefined {
    const reasoning = validateOptionalField("reasoning", value, MAX_REASONING_LENGTH);
    return reasoning !== undefined ? sanitizeForLogOutput(stripHtmlTags(reasoning)) : undefined;
  }

  getRegistry(): ToolRegistry {
    return this.registry;
  }
}
