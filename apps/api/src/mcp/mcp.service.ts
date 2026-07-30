import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InvalidTypeValueError, MAX_USER_ID_LENGTH, MAX_IDEMPOTENCY_KEY_LENGTH, SAFE_IDEMPOTENCY_KEY, MAX_AGENT_ID_LENGTH, MAX_CONVERSATION_ID_LENGTH, MAX_REASONING_LENGTH, stripHtmlTags, sanitizeForLogOutput } from "@besterp/shared";
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
    // Double-sanitize userId: stripHtmlTags removes HTML payloads,
    // sanitizeForLogOutput redacts secrets/URLs. Both are applied because
    // userId may be persisted to durable audit logs and reflected in agent-facing
    // messages. Defense-in-depth ensures no secret leakage even if one layer fails.
    const userId = sanitizeForLogOutput(stripHtmlTags(overrides.userId.trim()));
    if (userId.length === 0) {
      throw new InvalidTypeValueError(
        "McpService.buildContext: userId must not be empty or whitespace-only.",
        { context: { field: "userId" } }
      );
    }
    if (userId.length > MAX_USER_ID_LENGTH) {
      throw new InvalidTypeValueError(
        `McpService.buildContext: userId is too long (${userId.length} chars, max ${MAX_USER_ID_LENGTH}).`,
        { context: { field: "userId", length: userId.length, maxLength: MAX_USER_ID_LENGTH } }
      );
    }

    const rawIdempotencyKey = validateOptionalField("idempotencyKey", overrides.idempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH);
    if (rawIdempotencyKey !== undefined && !SAFE_IDEMPOTENCY_KEY.test(rawIdempotencyKey)) {
      throw new InvalidTypeValueError(
        "McpService.buildContext: idempotencyKey must contain only printable ASCII characters.",
        { context: { field: "idempotencyKey" } }
      );
    }
    const idempotencyKey = rawIdempotencyKey !== undefined ? sanitizeForLogOutput(stripHtmlTags(rawIdempotencyKey)) : undefined;

    const agentId = validateOptionalField("agentId", overrides.agentId, MAX_AGENT_ID_LENGTH);
    const conversationId = validateOptionalField("conversationId", overrides.conversationId, MAX_CONVERSATION_ID_LENGTH);
    const reasoning = validateOptionalField("reasoning", overrides.reasoning, MAX_REASONING_LENGTH);

    const safeAgentId = agentId !== undefined ? sanitizeForLogOutput(stripHtmlTags(agentId)) : undefined;
    const safeConversationId = conversationId !== undefined ? sanitizeForLogOutput(stripHtmlTags(conversationId)) : undefined;
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
}

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
