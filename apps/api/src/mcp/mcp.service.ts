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
   * All string inputs are sanitized to prevent secret leakage and XSS:
   * - HTML tags stripped via stripHtmlTags
   * - Secrets/URLs redacted via sanitizeForLogOutput
   * - Whitespace trimmed
   * - Length caps enforced via shared constants
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
  }) {
    if (typeof overrides.tenantId !== "string") {
      throw new InvalidTypeValueError(
        "McpService.buildContext: tenantId must be a string.",
        { context: { field: "tenantId", receivedType: typeof overrides.tenantId } }
      );
    }
    let tenantId = overrides.tenantId.trim();
    if (tenantId.length === 0) {
      throw new InvalidTypeValueError(
        "McpService.buildContext: tenantId must not be empty or whitespace-only.",
        { context: { field: "tenantId", receivedType: typeof overrides.tenantId } }
      );
    }
    tenantId = validateTenantIdEnhanced(tenantId);

    if (typeof overrides.userId !== "string") {
      throw new InvalidTypeValueError(
        "McpService.buildContext: userId must be a string.",
        { context: { field: "userId", receivedType: typeof overrides.userId } }
      );
    }
    // Validate format BEFORE sanitization: sanitizeForLogOutput can replace
    // secret-shaped substrings with [REDACTED_...] placeholders that contain
    // brackets, which fail TENANT_ID_PATTERN. Checking the raw trimmed value
    // first ensures a legitimate userId that happens to contain a secret-like
    // substring is not false-rejected by the pattern guard.
    const rawUserId = overrides.userId.trim();
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
    // Double-sanitize userId: stripHtmlTags removes HTML payloads,
    // sanitizeForLogOutput redacts secrets/URLs. Both are applied because
    // userId may be persisted to durable audit logs and reflected in agent-facing
    // messages. Defense-in-depth ensures no secret leakage even if one layer fails.
    const userId = sanitizeForLogOutput(stripHtmlTags(rawUserId));

    const rawIdempotencyKey = McpService.validateOptionalField("idempotencyKey", overrides.idempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH);
    if (rawIdempotencyKey !== undefined && !SAFE_IDEMPOTENCY_KEY.test(rawIdempotencyKey)) {
      throw new InvalidTypeValueError(
        "McpService.buildContext: idempotencyKey must contain only printable ASCII characters.",
        { context: { field: "idempotencyKey" } }
      );
    }
    const idempotencyKey = rawIdempotencyKey !== undefined ? sanitizeForLogOutput(stripHtmlTags(rawIdempotencyKey)) : undefined;

    const agentId = McpService.validateOptionalField("agentId", overrides.agentId, MAX_AGENT_ID_LENGTH);
    const conversationId = McpService.validateOptionalField("conversationId", overrides.conversationId, MAX_CONVERSATION_ID_LENGTH);

    // Enforce charset at the auth boundary for agentId and conversationId,
    // matching the guard already applied to userId above. These fields are
    // persisted verbatim into durable sinks (ai_action_log, idempotency_record),
    // so invalid chars must be rejected before sanitization runs — a value
    // containing e.g. `;` or `<` would otherwise only be caught later at the
    // tool-registry execution boundary, leaving a defense-in-depth gap.
    const rawAgentId = agentId ?? undefined;
    if (rawAgentId !== undefined && !TENANT_ID_PATTERN.test(rawAgentId)) {
      throw new InvalidTypeValueError(
        "McpService.buildContext: agentId contains invalid characters. " +
          "Agent IDs may only contain alphanumeric characters, hyphens, and underscores.",
        { context: { field: "agentId" } }
      );
    }
    const rawConversationId = conversationId ?? undefined;
    if (rawConversationId !== undefined && !TENANT_ID_PATTERN.test(rawConversationId)) {
      throw new InvalidTypeValueError(
        "McpService.buildContext: conversationId contains invalid characters. " +
          "Conversation IDs may only contain alphanumeric characters, hyphens, and underscores.",
        { context: { field: "conversationId" } }
      );
    }
    const safeAgentId = rawAgentId !== undefined ? sanitizeForLogOutput(stripHtmlTags(rawAgentId)) : undefined;
    const safeConversationId = rawConversationId !== undefined ? sanitizeForLogOutput(stripHtmlTags(rawConversationId)) : undefined;
    const reasoning = McpService.validateOptionalField("reasoning", overrides.reasoning, MAX_REASONING_LENGTH);
    const safeReasoning = reasoning !== undefined ? sanitizeForLogOutput(stripHtmlTags(reasoning)) : undefined;

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

  getRegistry(): ToolRegistry {
    return this.registry;
  }

  private static validateOptionalField(
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
}
