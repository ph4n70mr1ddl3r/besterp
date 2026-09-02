// Security Service — Core business logic for user and agent management.
//
// Implements ERP_PLAN.md Phase 0c: core-security
// Implements AGENTIC_AI_DESIGN.md §8.1: Agent Registry

import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service.js";
import {
  InvalidTypeValueError,
  EntityNotFoundError,
  DuplicateEntityError,
  ConcurrencyConflictError,
  MAX_USER_ID_LENGTH,
  MAX_AGENT_ID_LENGTH,
  MAX_PARTY_NAME_LENGTH,
  MAX_TENANT_ID_LENGTH,
  sanitizeForLogOutput,
} from "@besterp/shared";
import {
  CreateUserInput,
  UserResult,
  RegisterAgentInput,
  UpdateAgentInput,
  AgentResult,
  SearchAgentsInput,
  SearchAgentsResult,
} from "./security.types.js";

const DEFAULT_SEARCH_LIMIT = 50;
const MIN_SEARCH_LIMIT = 1;
const MAX_SEARCH_LIMIT = 500;
const MIN_SEARCH_OFFSET = 0;
const MAX_SEARCH_OFFSET = 10_000;

@Injectable()
export class SecurityService {
  private readonly logger = new Logger(SecurityService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── User ──────────────────────────────────────────────────────

  async createUser(input: CreateUserInput): Promise<UserResult> {
    const { tenantId, partyId, passwordHash } = input;

    const trimmedTenantId = this.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "create_user", "create_user");
    const validatedPartyId = this.requireNonEmpty(partyId, "partyId", MAX_USER_ID_LENGTH);
    this.requireNonEmpty(passwordHash, "passwordHash", 72);

    // Verify the party exists in this tenant before linking
    const party = await this.prisma.tenantScoped(trimmedTenantId).party.findUnique({
      where: { partyId: validatedPartyId },
      select: { tenantId: true },
    });
    if (!party) {
      throw new EntityNotFoundError(
        `Party '${sanitizeForLogOutput(validatedPartyId)}' not found in tenant '${sanitizeForLogOutput(trimmedTenantId)}'.`,
        { suggestedTools: ["search_parties", "get_party"] }
      );
    }
    if (party.tenantId !== trimmedTenantId) {
      throw new InvalidTypeValueError(
        `Party '${sanitizeForLogOutput(validatedPartyId)}' does not belong to tenant '${sanitizeForLogOutput(trimmedTenantId)}'.`,
        { suggestedTools: ["search_parties"] }
      );
    }

    try {
      const user = await this.prisma.tenantScoped(trimmedTenantId).user.create({
        data: {
          userId: crypto.randomUUID(),
          partyId: validatedPartyId,
          tenantId: trimmedTenantId,
          passwordHash,
        },
        select: {
          userId: true,
          partyId: true,
          tenantId: true,
          lastLoginAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      return this.toUserResult(user);
    } catch (err: unknown) {
      throw SecurityService.handleTransactionError(err, "create_user", "search_parties", "user");
    }
  }

  async getUser(tenantId: string, partyId: string): Promise<UserResult> {
    const trimmedTenantId = this.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "get_user", "search_parties");
    const validatedPartyId = this.requireNonEmpty(partyId, "partyId", MAX_USER_ID_LENGTH);
    const db = this.prisma.tenantScoped(trimmedTenantId);
    try {
      const user = await db.user.findUnique({
        where: { tenantId_partyId: { tenantId: trimmedTenantId, partyId: validatedPartyId } },
        select: {
          userId: true,
          partyId: true,
          tenantId: true,
          lastLoginAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      if (!user) {
        throw new EntityNotFoundError(
          `No user record found for party '${sanitizeForLogOutput(validatedPartyId)}' in tenant '${sanitizeForLogOutput(trimmedTenantId)}'.`,
          { suggestedTools: ["search_parties"] }
        );
      }
      return this.toUserResult(user);
    } catch (err) {
      if (err instanceof EntityNotFoundError) throw err;
      throw SecurityService.handleTransactionError(err, "get_user", "search_parties", "user");
    }
  }

  async updateLastLogin(tenantId: string, partyId: string): Promise<void> {
    const trimmedTenantId = this.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "update_last_login", "get_user");
    const validatedPartyId = this.requireNonEmpty(partyId, "partyId", MAX_USER_ID_LENGTH);
    try {
      await this.prisma.tenantScoped(trimmedTenantId).user.update({
        where: { tenantId_partyId: { tenantId: trimmedTenantId, partyId: validatedPartyId } },
        data: { lastLoginAt: new Date() },
      });
    } catch {
      // Non-fatal — login tracking failure should not block authentication.
      this.logger.debug(`Could not update lastLoginAt for party ${validatedPartyId}`);
    }
  }

  // ─── Agent Registry ────────────────────────────────────────────

  async registerAgent(input: RegisterAgentInput): Promise<AgentResult> {
    const {
      agentId,
      tenantId,
      displayName,
      description,
      capabilities,
      maxToolCallsPerConversation = 100,
      maxConcurrentConversations = 5,
      maxTransactionAmount = 0,
      allowedEntityTypes = [],
      rateLimitPerMinute = 30,
      version,
    } = input;

    const validatedAgentId = this.requireNonEmpty(agentId, "agentId", MAX_AGENT_ID_LENGTH);
    const validatedTenantId = this.requireNonEmpty(tenantId, "tenantId", MAX_TENANT_ID_LENGTH);
    this.requireNonEmpty(displayName, "displayName", MAX_PARTY_NAME_LENGTH);
    this.requireNonEmpty(description, "description", 1000);
    this.requireNonEmpty(version, "version", 64);
    this.validateAgentArrays(validatedAgentId, validatedTenantId, capabilities, allowedEntityTypes);
    this.validateAgentLimits(validatedAgentId, maxToolCallsPerConversation, rateLimitPerMinute);

    try {
      const agent = await this.prisma.admin.agentRegistry.create({
        data: {
          agentId: validatedAgentId,
          tenantId: validatedTenantId,
          displayName,
          description,
          capabilities,
          maxToolCallsPerConversation,
          maxConcurrentConversations,
          maxTransactionAmount: maxTransactionAmount ?? 0,
          allowedEntityTypes,
          rateLimitPerMinute,
          version,
          isActive: true,
        },
      });
      return this.toAgentResult(agent);
    } catch (err: unknown) {
      throw SecurityService.handleTransactionError(err, "register_agent", "list_agents", "agent");
    }
  }

  private validateAgentArrays(
    _agentId: string,
    _tenantId: string,
    capabilities: unknown,
    allowedEntityTypes: unknown,
  ): void {
    if (!Array.isArray(capabilities)) {
      throw new InvalidTypeValueError("capabilities must be a string array.", {
        suggestedTools: ["register_agent"],
      });
    }
    if (capabilities.length > 50) {
      throw new InvalidTypeValueError("capabilities must have at most 50 entries.", {
        suggestedTools: ["register_agent"],
      });
    }
    if (!Array.isArray(allowedEntityTypes)) {
      throw new InvalidTypeValueError("allowedEntityTypes must be a string array.", {
        suggestedTools: ["register_agent"],
      });
    }
  }

  private validateAgentLimits(
    _agentId: string,
    maxToolCallsPerConversation: number,
    rateLimitPerMinute: number,
  ): void {
    if (maxToolCallsPerConversation < 1 || maxToolCallsPerConversation > 10000) {
      throw new InvalidTypeValueError(
        `maxToolCallsPerConversation must be between 1 and 10000, got ${maxToolCallsPerConversation}.`,
        { suggestedTools: ["register_agent"] }
      );
    }
    if (rateLimitPerMinute < 1 || rateLimitPerMinute > 1000) {
      throw new InvalidTypeValueError(
        `rateLimitPerMinute must be between 1 and 1000, got ${rateLimitPerMinute}.`,
        { suggestedTools: ["register_agent"] }
      );
    }
  }

  async updateAgent(input: UpdateAgentInput): Promise<AgentResult> {
    const { agentId, tenantId, ...updates } = input;

    const trimmedTenantId = this.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "update_agent", "list_agents");
    const validatedAgentId = this.requireNonEmpty(agentId, "agentId", MAX_AGENT_ID_LENGTH);

    const updateData: Record<string, unknown> = {};
    if (updates.displayName !== undefined) updateData.displayName = updates.displayName;
    if (updates.description !== undefined) updateData.description = updates.description;
    if (updates.capabilities !== undefined) updateData.capabilities = updates.capabilities;
    if (updates.maxToolCallsPerConversation !== undefined)
      updateData.maxToolCallsPerConversation = updates.maxToolCallsPerConversation;
    if (updates.maxConcurrentConversations !== undefined)
      updateData.maxConcurrentConversations = updates.maxConcurrentConversations;
    if (updates.maxTransactionAmount !== undefined)
      updateData.maxTransactionAmount = updates.maxTransactionAmount;
    if (updates.allowedEntityTypes !== undefined)
      updateData.allowedEntityTypes = updates.allowedEntityTypes;
    if (updates.rateLimitPerMinute !== undefined)
      updateData.rateLimitPerMinute = updates.rateLimitPerMinute;
    if (updates.version !== undefined) updateData.version = updates.version;
    if (updates.isActive !== undefined) updateData.isActive = updates.isActive;

    if (Object.keys(updateData).length === 0) {
      throw new InvalidTypeValueError("No update fields provided.", {
        suggestedTools: ["list_agents"],
      });
    }

    try {
      const agent = await this.prisma.admin.agentRegistry.update({
        where: { agentId: validatedAgentId, tenantId: trimmedTenantId },
        data: updateData,
      });
      return this.toAgentResult(agent);
    } catch (err: unknown) {
      throw SecurityService.handleTransactionError(err, "update_agent", "list_agents", "agent");
    }
  }

  async deleteAgent(tenantId: string, agentId: string): Promise<{ success: boolean }> {
    const trimmedTenantId = this.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "delete_agent", "list_agents");
    const validatedAgentId = this.requireNonEmpty(agentId, "agentId", MAX_AGENT_ID_LENGTH);
    try {
      await this.prisma.admin.agentRegistry.delete({
        where: { agentId: validatedAgentId, tenantId: trimmedTenantId },
      });
      return { success: true };
    } catch (err: unknown) {
      throw SecurityService.handleTransactionError(err, "delete_agent", "list_agents", "agent");
    }
  }

  async getAgent(tenantId: string, agentId: string): Promise<AgentResult> {
    const trimmedTenantId = this.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "get_agent", "list_agents");
    const validatedAgentId = this.requireNonEmpty(agentId, "agentId", MAX_AGENT_ID_LENGTH);
    const agent = await this.prisma.admin.agentRegistry.findUnique({
      where: { agentId: validatedAgentId, tenantId: trimmedTenantId },
    });
    if (!agent) {
      throw new EntityNotFoundError(
        `Agent '${sanitizeForLogOutput(validatedAgentId)}' not found in tenant '${sanitizeForLogOutput(trimmedTenantId)}'.`,
        { suggestedTools: ["list_agents", "register_agent"] }
      );
    }
    return this.toAgentResult(agent);
  }

  async searchAgents(input: SearchAgentsInput): Promise<SearchAgentsResult> {
    const {
      tenantId,
      agentId,
      isActive,
      limit = DEFAULT_SEARCH_LIMIT,
      offset = 0,
    } = input;

    const trimmedTenantId = this.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "search_agents", "list_agents");
    const validatedLimit = Math.min(Math.max(limit, MIN_SEARCH_LIMIT), MAX_SEARCH_LIMIT);
    const validatedOffset = Math.min(Math.max(offset, MIN_SEARCH_OFFSET), MAX_SEARCH_OFFSET);

    const where: Record<string, unknown> = { tenantId: trimmedTenantId };
    if (agentId) where.agentId = agentId;
    if (isActive !== undefined) where.isActive = isActive;

    // Run count first, then findMany with the validated limit. Under READ
    // COMMITTED, concurrent INSERTs between a parallel count+findMany can cause
    // `total` and `items.length` to disagree (worst case: off-by-one in hasMore).
    // Running sequentially avoids this, matching the PartyService/ProductService
    // pattern (round 176).
    let total: number;
    let items: Awaited<ReturnType<typeof this.prisma.admin.agentRegistry.findMany>>;
    try {
      total = await this.prisma.admin.agentRegistry.count({ where });
      items = await this.prisma.admin.agentRegistry.findMany({
        where,
        orderBy: { createdAt: "asc" },
        skip: validatedOffset,
        take: validatedLimit,
      });
    } catch (err) {
      throw SecurityService.handleTransactionError(err, "search_agents", "list_agents", "agent");
    }

    return {
      items: items.map((a) => this.toAgentResult(a)),
      total,
      limit: validatedLimit,
      offset: validatedOffset,
      hasMore: validatedOffset + validatedLimit < total && validatedOffset + validatedLimit <= MAX_SEARCH_OFFSET,
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────

  private static getPrismaErrorCode(err: unknown): string | undefined {
    if (err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string") {
      return (err as { code: string }).code;
    }
    return undefined;
  }

  private static throwMappedPrismaError(
    code: string,
    err: { code: string; meta?: Record<string, unknown> },
    retryTool: string,
    suggestTool: string,
    entityName: string,
  ): never {
    switch (code) {
      case "P2002": {
        const meta = err.meta as Record<string, unknown> | undefined;
        const target = meta?.target as string[] | undefined;
        const field = Array.isArray(target) && target.length > 0 && typeof target[0] === "string"
          ? target.join(" and ")
          : "unique key";
        throw new DuplicateEntityError(
          `A ${entityName} with the same ${field} already exists.`,
          { suggestedTools: [suggestTool], context: { prismaCode: "P2002", conflictingField: field } }
        );
      }
      case "P2003": {
        const meta = err.meta as Record<string, unknown> | undefined;
        const constraint = (meta?.constraint as string | undefined) ?? "unknown";
        throw new InvalidTypeValueError(
          `Referenced ${entityName} does not exist (constraint: ${constraint}).`,
          { suggestedTools: [suggestTool], context: { prismaCode: "P2003", constraint } }
        );
      }
      case "P2025": {
        throw new EntityNotFoundError(
          `${entityName} not found for this operation.`,
          { suggestedTools: [retryTool, suggestTool], context: { prismaCode: "P2025" } }
        );
      }
      case "P2028":
      case "P2034": {
        throw new ConcurrencyConflictError(
          `Transaction conflict or timeout on ${entityName} — please retry.`,
          { suggestedTools: [retryTool], context: { prismaCode: code } }
        );
      }
      case "P2024": {
        throw new ConcurrencyConflictError(
          `Connection pool timeout on ${entityName} — the service is under heavy load.`,
          { suggestedTools: [retryTool], context: { prismaCode: code } }
        );
      }
      default: {
        throw err;
      }
    }
  }

  private static handleTransactionError(
    err: unknown,
    retryTool: string,
    suggestTool: string,
    entityName = "record",
  ): never {
    if (err == null || typeof err !== "object") {
      throw new InvalidTypeValueError(
        "Database operation failed with an unexpected error type.",
        { context: { type: err === null ? "null" : typeof err } }
      );
    }
    const code = SecurityService.getPrismaErrorCode(err);
    if (!code) throw err;
    if (!/^P\d{4}$/.test(code)) throw err;
    if (/^P1\d{3}$/.test(code)) throw err;
    return SecurityService.throwMappedPrismaError(code, err as { code: string; meta?: Record<string, unknown> }, retryTool, suggestTool, entityName);
  }

  private toUserResult(u: {
    userId: string;
    partyId: string;
    tenantId: string;
    lastLoginAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): UserResult {
    return {
      userId: u.userId,
      partyId: u.partyId,
      tenantId: u.tenantId,
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      createdAt: u.createdAt.toISOString(),
      updatedAt: u.updatedAt.toISOString(),
    };
  }

  private toAgentResult(a: {
    agentId: string;
    tenantId: string;
    displayName: string;
    description: string;
    capabilities: unknown;
    maxToolCallsPerConversation: number;
    maxConcurrentConversations: number;
    maxTransactionAmount: unknown;
    allowedEntityTypes: unknown;
    rateLimitPerMinute: number;
    version: string;
    isActive: boolean;
    createdAt: Date;
  }): AgentResult {
    return {
      agentId: a.agentId,
      tenantId: a.tenantId,
      displayName: a.displayName,
      description: a.description,
      capabilities: Array.isArray(a.capabilities) ? a.capabilities : [],
      maxToolCallsPerConversation: a.maxToolCallsPerConversation,
      maxConcurrentConversations: a.maxConcurrentConversations,
      maxTransactionAmount: typeof a.maxTransactionAmount === "number" ? a.maxTransactionAmount : null,
      allowedEntityTypes: Array.isArray(a.allowedEntityTypes) ? a.allowedEntityTypes : [],
      rateLimitPerMinute: a.rateLimitPerMinute,
      version: a.version,
      isActive: a.isActive,
      createdAt: a.createdAt.toISOString(),
    };
  }

  private requireNonEmpty(value: string, field: string, maxLength: number): string {
    if (typeof value !== "string") {
      throw new InvalidTypeValueError(
        `'${field}' must be a string.`,
        { suggestedTools: ["list_agents"] }
      );
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new InvalidTypeValueError(
        `'${field}' must not be empty or whitespace-only.`,
        { suggestedTools: ["list_agents"] }
      );
    }
    if (trimmed.length > maxLength) {
      throw new InvalidTypeValueError(
        `'${field}' exceeds maximum length of ${maxLength} characters (got ${trimmed.length}).`,
        { suggestedTools: ["list_agents"] }
      );
    }
    return trimmed;
  }

  private requireStringField(value: unknown, field: string, maxLength: number, _action: string, tool: string): string {
    if (typeof value !== "string") {
      throw new InvalidTypeValueError(`'${field}' must be a string.`, { suggestedTools: [tool], context: { field, received: typeof value } });
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new InvalidTypeValueError(`'${field}' must not be empty.`, { suggestedTools: [tool], context: { field } });
    }
    if (trimmed.length > maxLength) {
      throw new InvalidTypeValueError(`'${field}' exceeds maximum length of ${maxLength} characters.`, { suggestedTools: [tool], context: { field, length: trimmed.length } });
    }
    return trimmed;
  }
}
