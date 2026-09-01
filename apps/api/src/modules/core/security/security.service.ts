// Security Service — Core business logic for user and agent management.
//
// Implements ERP_PLAN.md Phase 0c: core-security
// Implements AGENTIC_AI_DESIGN.md §8.1: Agent Registry

import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service.js";
import {
  InvalidTypeValueError,
  EntityNotFoundError,
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
    this.requireNonEmpty(partyId, "partyId", MAX_USER_ID_LENGTH);
    this.requireNonEmpty(passwordHash, "passwordHash", 72);

    // Verify the party exists in this tenant before linking
    const party = await this.prisma.tenantScoped(trimmedTenantId).party.findUnique({
      where: { partyId },
      select: { tenantId: true },
    });
    if (!party) {
      throw new EntityNotFoundError(
        `Party '${sanitizeForLogOutput(partyId)}' not found in tenant '${sanitizeForLogOutput(trimmedTenantId)}'.`,
        { suggestedTools: ["search_parties", "get_party"] }
      );
    }
    if (party.tenantId !== trimmedTenantId) {
      throw new InvalidTypeValueError(
        `Party '${sanitizeForLogOutput(partyId)}' does not belong to tenant '${sanitizeForLogOutput(trimmedTenantId)}'.`,
        { suggestedTools: ["search_parties"] }
      );
    }

    try {
      const user = await this.prisma.tenantScoped(trimmedTenantId).user.create({
        data: {
          userId: crypto.randomUUID(),
          partyId,
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
      const code = (err as { code?: string })?.code;
      if (code === "P2002") {
        throw new InvalidTypeValueError(
          `A user is already linked to party '${sanitizeForLogOutput(partyId)}' in this tenant.`,
          { suggestedTools: ["search_parties", "get_party"] }
        );
      }
      throw err;
    }
  }

  async getUser(tenantId: string, partyId: string): Promise<UserResult> {
    const trimmedTenantId = this.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "get_user", "search_parties");
    this.requireNonEmpty(partyId, "partyId", MAX_USER_ID_LENGTH);
    try {
      const user = await this.prisma.tenantScoped(trimmedTenantId).user.findUnique({
        where: { tenantId_partyId: { tenantId: trimmedTenantId, partyId } },
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
          `No user record found for party '${sanitizeForLogOutput(partyId)}' in tenant '${sanitizeForLogOutput(trimmedTenantId)}'.`,
          { suggestedTools: ["search_parties"] }
        );
      }
      return this.toUserResult(user);
    } catch (err) {
      if (err instanceof EntityNotFoundError) throw err;
      throw new InvalidTypeValueError(
        `Failed to retrieve user for party '${sanitizeForLogOutput(partyId)}'.`,
        { suggestedTools: ["search_parties"] }
      );
    }
  }

  async updateLastLogin(tenantId: string, partyId: string): Promise<void> {
    try {
      await this.prisma.tenantScoped(tenantId).user.update({
        where: { tenantId_partyId: { tenantId, partyId } },
        data: { lastLoginAt: new Date() },
      });
    } catch {
      // Non-fatal — login tracking failure should not block authentication.
      this.logger.debug(`Could not update lastLoginAt for party ${partyId}`);
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

    this.requireNonEmpty(agentId, "agentId", MAX_AGENT_ID_LENGTH);
    this.requireNonEmpty(displayName, "displayName", MAX_PARTY_NAME_LENGTH);
    this.requireNonEmpty(description, "description", 1000);
    this.requireNonEmpty(version, "version", 64);
    this.validateAgentArrays(agentId, tenantId, capabilities, allowedEntityTypes);
    this.validateAgentLimits(agentId, maxToolCallsPerConversation, rateLimitPerMinute);

    try {
      const agent = await this.prisma.admin.agentRegistry.create({
        data: {
          agentId,
          tenantId,
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
      const code = (err as { code?: string })?.code;
      if (code === "P2002") {
        throw new InvalidTypeValueError(
          `Agent '${sanitizeForLogOutput(agentId)}' is already registered in tenant '${sanitizeForLogOutput(tenantId)}'.`,
          { suggestedTools: ["list_agents", "describe_agent"] }
        );
      }
      throw err;
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
    this.requireNonEmpty(agentId, "agentId", MAX_AGENT_ID_LENGTH);

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
        where: { agentId, tenantId: trimmedTenantId },
        data: updateData,
      });
      return this.toAgentResult(agent);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "P2025") {
        throw new EntityNotFoundError(
          `Agent '${sanitizeForLogOutput(agentId)}' not found in tenant '${sanitizeForLogOutput(tenantId)}'.`,
          { suggestedTools: ["list_agents", "register_agent"] }
        );
      }
      throw err;
    }
  }

  async deleteAgent(tenantId: string, agentId: string): Promise<{ success: boolean }> {
    const trimmedTenantId = this.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "delete_agent", "list_agents");
    this.requireNonEmpty(agentId, "agentId", MAX_AGENT_ID_LENGTH);
    try {
      await this.prisma.admin.agentRegistry.delete({
        where: { agentId, tenantId: trimmedTenantId },
      });
      return { success: true };
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "P2025") {
        throw new EntityNotFoundError(
          `Agent '${sanitizeForLogOutput(agentId)}' not found in tenant '${sanitizeForLogOutput(tenantId)}'.`,
          { suggestedTools: ["list_agents"] }
        );
      }
      throw err;
    }
  }

  async getAgent(tenantId: string, agentId: string): Promise<AgentResult> {
    const trimmedTenantId = this.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "get_agent", "list_agents");
    this.requireNonEmpty(agentId, "agentId", MAX_AGENT_ID_LENGTH);
    const agent = await this.prisma.admin.agentRegistry.findUnique({
      where: { agentId, tenantId: trimmedTenantId },
    });
    if (!agent) {
      throw new EntityNotFoundError(
        `Agent '${sanitizeForLogOutput(agentId)}' not found in tenant '${sanitizeForLogOutput(tenantId)}'.`,
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

    const [items, total] = await Promise.all([
      this.prisma.admin.agentRegistry.findMany({
        where,
        orderBy: { createdAt: "asc" },
        skip: offset,
        take: limit,
      }),
      this.prisma.admin.agentRegistry.count({ where }),
    ]);

    return {
      items: items.map((a) => this.toAgentResult(a)),
      total,
      limit: validatedLimit,
      offset: validatedOffset,
      hasMore: validatedOffset + validatedLimit < total && validatedOffset + validatedLimit <= MAX_SEARCH_OFFSET,
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────

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

  private requireNonEmpty(value: string, field: string, maxLength: number): void {
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
