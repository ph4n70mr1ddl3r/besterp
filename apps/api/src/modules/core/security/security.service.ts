// Security Service — Core business logic for user and agent management.
//
// Implements ERP_PLAN.md Phase 0c: core-security
// Implements AGENTIC_AI_DESIGN.md §8.1: Agent Registry

import { Injectable, Logger } from "@nestjs/common";
import * as crypto from "node:crypto";
import { PrismaService } from "../../../prisma/prisma.service.js";
import {
  InvalidTypeValueError,
  EntityNotFoundError,
  UUID_REGEX,
  MAX_AGENT_ID_LENGTH,
  MAX_PARTY_NAME_LENGTH,
  MAX_TENANT_ID_LENGTH,
  MAX_PASSWORD_HASH_LENGTH,
  MAX_AGENT_DESCRIPTION_LENGTH,
  MAX_VERSION_LENGTH,
  MAX_CAPABILITIES_LENGTH,
  MAX_CAPABILITY_STRING_LENGTH,
  MAX_ALLOWED_ENTITY_TYPES_LENGTH,
  MAX_ENTITY_LENGTH,
  sanitizeForLogOutput,
  stripHtmlTags,
  computeHasMore,
  handleTransactionError as mapPrismaError,
  decimalToNumber,
  DEFAULT_SEARCH_LIMIT,
  MIN_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MIN_SEARCH_OFFSET,
  MAX_SEARCH_OFFSET,
  DEFAULT_MAX_TOOL_CALLS_PER_CONVERSATION,
  MIN_MAX_TOOL_CALLS_PER_CONVERSATION,
  MAX_MAX_TOOL_CALLS_PER_CONVERSATION,
  DEFAULT_MAX_CONCURRENT_CONVERSATIONS,
  MIN_MAX_CONCURRENT_CONVERSATIONS,
  MAX_MAX_CONCURRENT_CONVERSATIONS,
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  MIN_RATE_LIMIT_PER_MINUTE,
  MAX_RATE_LIMIT_PER_MINUTE,
  isSupportedPasswordHash,
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

@Injectable()
export class SecurityService {
  private readonly logger = new Logger(SecurityService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── User ──────────────────────────────────────────────────────

  async createUser(input: CreateUserInput): Promise<UserResult> {
    const { tenantId, partyId, passwordHash } = input;

    const trimmedTenantId = SecurityService.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "create_user");
    const validatedPartyId = SecurityService.requireUuid(partyId, "partyId", ["create_user"]);
    const trimmedPasswordHash = SecurityService.requireStringField(passwordHash, "passwordHash", MAX_PASSWORD_HASH_LENGTH, "create_user");

    // The hash must LOOK like a hash. This is the authoritative write path
    // to `user.password_hash` — the only credential store in the schema —
    // and it used to accept any non-empty string up to 255 characters, so a
    // mistaken or prompt-injected agent could persist a PLAINTEXT password
    // verbatim into the credential column and the tool would still report
    // `success: true`. The shape check cannot verify that a digest matches a
    // password, but it does reject the plaintext case.
    if (!isSupportedPasswordHash(trimmedPasswordHash)) {
      throw new InvalidTypeValueError(
        "'passwordHash' must be a bcrypt or argon2 digest, not a plaintext password.",
        {
          suggestedTools: ["get_user"],
          context: { field: "passwordHash", expectedFormat: "bcrypt or argon2" },
        },
      );
    }

    // Verify the party exists in this tenant before linking
    let party;
    try {
      party = await this.prisma.tenantScoped(trimmedTenantId).party.findUnique({
        where: { partyId: validatedPartyId },
        select: { tenantId: true },
      });
    } catch (err) {
      throw mapPrismaError(err, "create_user", "create_user", "user");
    }
    if (!party) {
      throw new EntityNotFoundError(
        `Party '${sanitizeForLogOutput(validatedPartyId)}' not found in tenant '${sanitizeForLogOutput(trimmedTenantId)}'.`,
        { suggestedTools: ["search_parties", "get_party"], context: { partyId: validatedPartyId, tenantId: trimmedTenantId } }
      );
    }
    if (party.tenantId !== trimmedTenantId) {
      throw new InvalidTypeValueError(
        `Party '${sanitizeForLogOutput(validatedPartyId)}' does not belong to tenant '${sanitizeForLogOutput(trimmedTenantId)}'.`,
        { suggestedTools: ["search_parties"], context: { partyId: validatedPartyId, tenantId: trimmedTenantId } }
      );
    }

    try {
      const user = await this.prisma.tenantScoped(trimmedTenantId).user.create({
        data: {
          userId: crypto.randomUUID(),
          partyId: validatedPartyId,
          tenantId: trimmedTenantId,
          passwordHash: trimmedPasswordHash,
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
      return SecurityService.toUserResult(user);
    } catch (err: unknown) {
      throw mapPrismaError(err, "create_user", "create_user", "user");
    }
  }

  async getUser(tenantId: string, partyId: string): Promise<UserResult> {
    const trimmedTenantId = SecurityService.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "get_user");
    const validatedPartyId = SecurityService.requireUuid(partyId, "partyId", ["get_user"]);
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
          { suggestedTools: ["get_user", "search_parties"], context: { partyId: validatedPartyId, tenantId: trimmedTenantId } }
        );
      }
      return SecurityService.toUserResult(user);
    } catch (err) {
      if (err instanceof EntityNotFoundError) throw err;
      throw mapPrismaError(err, "get_user", "get_user", "user");
    }
  }

  /**
   * Record a successful login for a user account.
   *
   * NOT YET WIRED TO A CALLER: there is no authentication endpoint in this
   * service — the JWT is issued by an external identity provider — so no
   * production path calls this yet. It is kept (rather than deleted) because
   * it is the only write path to `user.last_login_at`, and the column is
   * part of the user record's contract. A future login flow (or an MCP tool
   * that records the login of the user an agent acts for) is its caller.
   *
   * The failure is deliberately NON-FATAL: a login-tracking write must
   * never block authentication.
   */
  async updateLastLogin(tenantId: string, partyId: string): Promise<void> {
    const trimmedTenantId = SecurityService.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "update_last_login");
    const validatedPartyId = SecurityService.requireUuid(partyId, "partyId", ["update_last_login"]);
    try {
      await this.prisma.tenantScoped(trimmedTenantId).user.update({
        where: { tenantId_partyId: { tenantId: trimmedTenantId, partyId: validatedPartyId } },
        data: { lastLoginAt: new Date() },
      });
    } catch {
      // Non-fatal — login tracking failure should not block authentication.
      this.logger.debug(`Could not update lastLoginAt for party ${sanitizeForLogOutput(validatedPartyId)}`);
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
      maxToolCallsPerConversation = DEFAULT_MAX_TOOL_CALLS_PER_CONVERSATION,
      maxConcurrentConversations = DEFAULT_MAX_CONCURRENT_CONVERSATIONS,
      maxTransactionAmount = 0,
      allowedEntityTypes = [],
      rateLimitPerMinute = DEFAULT_RATE_LIMIT_PER_MINUTE,
      version,
    } = input;

    const rawAgentId = SecurityService.requireStringField(agentId, "agentId", MAX_AGENT_ID_LENGTH, "register_agent");
    const validatedAgentId = stripHtmlTags(rawAgentId);
    if (validatedAgentId.length === 0) {
      throw new InvalidTypeValueError("'agentId' must contain visible characters after HTML sanitization.", { suggestedTools: ["register_agent"], context: { field: "agentId" } });
    }
    const validatedTenantId = SecurityService.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "register_agent");
    const trimmedDisplayName = SecurityService.requireStringField(displayName, "displayName", MAX_PARTY_NAME_LENGTH, "register_agent");
    const trimmedDescription = SecurityService.requireStringField(description, "description", MAX_AGENT_DESCRIPTION_LENGTH, "register_agent");
    const trimmedVersion = SecurityService.requireStringField(version, "version", MAX_VERSION_LENGTH, "register_agent");
    if (stripHtmlTags(trimmedDisplayName).length === 0) {
      throw new InvalidTypeValueError("'displayName' must contain visible characters after HTML sanitization.", { suggestedTools: ["register_agent"], context: { field: "displayName" } });
    }
    if (stripHtmlTags(trimmedDescription).length === 0) {
      throw new InvalidTypeValueError("'description' must contain visible characters after HTML sanitization.", { suggestedTools: ["register_agent"], context: { field: "description" } });
    }
    if (stripHtmlTags(trimmedVersion).length === 0) {
      throw new InvalidTypeValueError("'version' must contain visible characters after HTML sanitization.", { suggestedTools: ["register_agent"], context: { field: "version" } });
    }
    SecurityService.validateAgentArrays(capabilities, allowedEntityTypes, "register_agent");
    const sanitizedCapabilities = capabilities.map((c: string) => stripHtmlTags(c.trim()));
    const sanitizedAllowedEntityTypes = allowedEntityTypes.map((e: string) => stripHtmlTags(e.trim()));
    SecurityService.validateAgentLimits(maxToolCallsPerConversation, rateLimitPerMinute, "register_agent");
    SecurityService.validateMaxConcurrentConversations(maxConcurrentConversations, "register_agent");
    SecurityService.validateMaxTransactionAmount(maxTransactionAmount, "register_agent");

    try {
      // The agent registry is a TENANT-SCOPED table with RLS enabled and
      // forced (rls-setup.sql) — the boot-time RLS verification lists it
      // among the protected tables. It was nevertheless read and written
      // through the ADMIN client (the superuser connection, which ALWAYS
      // bypasses RLS), so its tenant isolation rested entirely on the
      // explicit `tenantId` filter at each call site while the rest of this
      // very file used the RLS-enforced tenant-scoped client for the OTHER
      // tenant tables (`party`, `user`). Use the tenant-scoped client so the
      // database-level backstop actually applies.
      const agent = await this.prisma.tenantScoped(validatedTenantId).agentRegistry.create({
        data: {
          agentId: validatedAgentId,
          tenantId: validatedTenantId,
          displayName: stripHtmlTags(trimmedDisplayName),
          description: stripHtmlTags(trimmedDescription),
          capabilities: sanitizedCapabilities,
          maxToolCallsPerConversation,
          maxConcurrentConversations,
          maxTransactionAmount,
          allowedEntityTypes: sanitizedAllowedEntityTypes,
          rateLimitPerMinute,
          version: stripHtmlTags(trimmedVersion),
          isActive: true,
        },
      });
      this.logger.log(`Registered agent: ${sanitizeForLogOutput(trimmedDisplayName)} (${validatedAgentId})`);
      return SecurityService.toAgentResult(agent);
    } catch (err: unknown) {
      throw mapPrismaError(err, "register_agent", "register_agent", "agent");
    }
  }

  private static validateAgentArrays(
    capabilities: unknown,
    allowedEntityTypes: unknown,
    tool: string,
  ): void {
    if (!Array.isArray(capabilities)) {
      throw new InvalidTypeValueError("'capabilities' must be a string array.", {
        suggestedTools: [tool],
        context: { field: "capabilities", received: typeof capabilities },
      });
    }
    if (capabilities.length > MAX_CAPABILITIES_LENGTH) {
      throw new InvalidTypeValueError(`'capabilities' must have at most ${MAX_CAPABILITIES_LENGTH} entries.`, {
        suggestedTools: [tool],
        context: { field: "capabilities", length: (capabilities as unknown[]).length },
      });
    }
    for (const item of capabilities) {
      if (typeof item !== "string") {
        throw new InvalidTypeValueError(`'capability' must be a non-empty string.`, {
          suggestedTools: [tool],
          context: { field: "capabilities", received: typeof item },
        });
      }
      const stripped = stripHtmlTags(item.trim());
      if (stripped.length === 0) {
        throw new InvalidTypeValueError(`'capability' must contain visible characters after HTML sanitization.`, {
          suggestedTools: [tool],
          context: { field: "capabilities" },
        });
      }
      if (stripped.length > MAX_CAPABILITY_STRING_LENGTH) {
        throw new InvalidTypeValueError(`'capability' exceeds maximum length of ${MAX_CAPABILITY_STRING_LENGTH} characters.`, {
          suggestedTools: [tool],
          context: { field: "capabilities", length: stripped.length },
        });
      }
    }
    if (!Array.isArray(allowedEntityTypes)) {
      throw new InvalidTypeValueError("'allowedEntityTypes' must be a string array.", {
        suggestedTools: [tool],
        context: { field: "allowedEntityTypes", received: typeof allowedEntityTypes },
      });
    }
    // `allowedEntityTypes` is a free-form JSON array with no database-side
    // bound, so the cap must be enforced here as well as at the MCP
    // boundary — mirroring the `capabilities` bound above. Without it, a
    // direct/internal caller could persist an arbitrarily large array.
    if (allowedEntityTypes.length > MAX_ALLOWED_ENTITY_TYPES_LENGTH) {
      throw new InvalidTypeValueError(`'allowedEntityTypes' must have at most ${MAX_ALLOWED_ENTITY_TYPES_LENGTH} entries.`, {
        suggestedTools: [tool],
        context: { field: "allowedEntityTypes", length: (allowedEntityTypes as unknown[]).length },
      });
    }
    for (const item of allowedEntityTypes) {
      if (typeof item !== "string") {
        throw new InvalidTypeValueError(`'allowedEntityType' must be a non-empty string.`, {
          suggestedTools: [tool],
          context: { field: "allowedEntityTypes", received: typeof item },
        });
      }
      const stripped = stripHtmlTags(item.trim());
      if (stripped.length === 0) {
        throw new InvalidTypeValueError(`'allowedEntityType' must contain visible characters after HTML sanitization.`, {
          suggestedTools: [tool],
          context: { field: "allowedEntityTypes" },
        });
      }
      if (stripped.length > MAX_ENTITY_LENGTH) {
        throw new InvalidTypeValueError(`'allowedEntityType' exceeds maximum length of ${MAX_ENTITY_LENGTH} characters.`, {
          suggestedTools: [tool],
          context: { field: "allowedEntityTypes", length: stripped.length },
        });
      }
    }
  }

  private static validateAgentLimits(
    maxToolCallsPerConversation: number | undefined,
    rateLimitPerMinute: number | undefined,
    tool: string,
  ): void {
    if (maxToolCallsPerConversation !== undefined && (maxToolCallsPerConversation < MIN_MAX_TOOL_CALLS_PER_CONVERSATION || maxToolCallsPerConversation > MAX_MAX_TOOL_CALLS_PER_CONVERSATION)) {
      throw new InvalidTypeValueError(
        `maxToolCallsPerConversation must be between ${MIN_MAX_TOOL_CALLS_PER_CONVERSATION} and ${MAX_MAX_TOOL_CALLS_PER_CONVERSATION}, got ${maxToolCallsPerConversation}.`,
        { suggestedTools: [tool], context: { field: "maxToolCallsPerConversation", value: maxToolCallsPerConversation } }
      );
    }
    if (rateLimitPerMinute !== undefined && (rateLimitPerMinute < MIN_RATE_LIMIT_PER_MINUTE || rateLimitPerMinute > MAX_RATE_LIMIT_PER_MINUTE)) {
      throw new InvalidTypeValueError(
        `rateLimitPerMinute must be between ${MIN_RATE_LIMIT_PER_MINUTE} and ${MAX_RATE_LIMIT_PER_MINUTE}, got ${rateLimitPerMinute}.`,
        { suggestedTools: [tool], context: { field: "rateLimitPerMinute", value: rateLimitPerMinute } }
      );
    }
  }

  /** Validate maxConcurrentConversations: must be between 1 and 100.
   *  Mirrors the Zod schema (agent-tools.ts) so the service layer rejects
   *  out-of-range values for direct/internal callers that bypass Zod (round 234). */
  private static validateMaxConcurrentConversations(value: number, tool: string): void {
    if (value < MIN_MAX_CONCURRENT_CONVERSATIONS || value > MAX_MAX_CONCURRENT_CONVERSATIONS) {
      throw new InvalidTypeValueError(
        `maxConcurrentConversations must be between ${MIN_MAX_CONCURRENT_CONVERSATIONS} and ${MAX_MAX_CONCURRENT_CONVERSATIONS}, got ${value}.`,
        { suggestedTools: [tool], context: { field: "maxConcurrentConversations", value } }
      );
    }
  }

  /** Validate maxTransactionAmount: must be >= 0.
   *  Mirrors the Zod schema (agent-tools.ts) so the service layer rejects
   *  negative values for direct/internal callers that bypass Zod (round 234). */
  private static validateMaxTransactionAmount(value: number, tool: string): void {
    if (value < 0) {
      throw new InvalidTypeValueError(
        `maxTransactionAmount must be non-negative, got ${value}.`,
        { suggestedTools: [tool], context: { field: "maxTransactionAmount", value } }
      );
    }
  }

  async updateAgent(input: UpdateAgentInput): Promise<AgentResult> {
    const { agentId, tenantId, ...updates } = input;

    const trimmedTenantId = SecurityService.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "update_agent");
    const rawAgentId = SecurityService.requireStringField(agentId, "agentId", MAX_AGENT_ID_LENGTH, "update_agent");
    const validatedAgentId = stripHtmlTags(rawAgentId);
    if (validatedAgentId.length === 0) {
      throw new InvalidTypeValueError("'agentId' must contain visible characters after HTML sanitization.", { suggestedTools: ["update_agent"], context: { field: "agentId" } });
    }

    // Validate array fields when provided — mirrors registerAgent so the
    // service layer remains the last line of defense for direct/internal
    // callers that bypass the Zod boundary (round 206).
    if (updates.capabilities !== undefined || updates.allowedEntityTypes !== undefined) {
      SecurityService.validateAgentArrays(
        updates.capabilities ?? [],
        updates.allowedEntityTypes ?? [],
        "update_agent",
      );
    }
    // Validate numeric limits when provided — mirrors registerAgent so the
    // service layer rejects out-of-range values before they reach the DB
    // (round 206). A single conditional covers both fields so the combined
    // validateAgentLimits call runs once even when both are present; passing
    // undefined for the untouched field is safe because validateAgentLimits
    // skips the range check when the value is undefined.
    if (updates.maxToolCallsPerConversation !== undefined || updates.rateLimitPerMinute !== undefined) {
      SecurityService.validateAgentLimits(
        updates.maxToolCallsPerConversation,
        updates.rateLimitPerMinute,
        "update_agent",
      );
    }
    // maxConcurrentConversations and maxTransactionAmount were previously
    // unchecked at the service layer — the Zod boundary enforced them but
    // direct/internal callers bypass Zod. Validate them here so the service
    // remains the last line of defense (round 234).
    if (updates.maxConcurrentConversations !== undefined) {
      SecurityService.validateMaxConcurrentConversations(updates.maxConcurrentConversations, "update_agent");
    }
    if (updates.maxTransactionAmount !== undefined) {
      SecurityService.validateMaxTransactionAmount(updates.maxTransactionAmount, "update_agent");
    }

    const updateData = SecurityService.buildUpdateData(updates);

    if (Object.keys(updateData).length === 0) {
      throw new InvalidTypeValueError("No update fields provided.", {
        suggestedTools: ["update_agent"],
      });
    }

    try {
      const agent = await this.prisma.tenantScoped(trimmedTenantId).agentRegistry.update({
        where: { agentId_tenantId: { agentId: validatedAgentId, tenantId: trimmedTenantId } },
        data: updateData,
      });
      this.logger.log(`Updated agent: ${sanitizeForLogOutput(validatedAgentId)}`);
      return SecurityService.toAgentResult(agent);
    } catch (err: unknown) {
      throw mapPrismaError(err, "update_agent", "update_agent", "agent");
    }
  }

  private static sanitizeUpdateCapabilities(values: unknown): string[] {
    if (!Array.isArray(values)) {
      throw new InvalidTypeValueError("'capabilities' must be a string array.", { suggestedTools: ["update_agent"], context: { field: "capabilities", received: typeof values } });
    }
    const sanitized: string[] = [];
    for (const c of values) {
      if (typeof c !== "string") {
        throw new InvalidTypeValueError("'capability' must be a non-empty string.", { suggestedTools: ["update_agent"], context: { field: "capabilities", received: typeof c } });
      }
      const stripped = stripHtmlTags(c.trim());
      if (stripped.length === 0) {
        throw new InvalidTypeValueError("'capability' must contain visible characters after HTML sanitization.", { suggestedTools: ["update_agent"], context: { field: "capabilities" } });
      }
      if (stripped.length > MAX_CAPABILITY_STRING_LENGTH) {
        throw new InvalidTypeValueError(`'capability' exceeds maximum length of ${MAX_CAPABILITY_STRING_LENGTH} characters.`, { suggestedTools: ["update_agent"], context: { field: "capabilities", length: stripped.length } });
      }
      sanitized.push(stripped);
    }
    if (sanitized.length > MAX_CAPABILITIES_LENGTH) {
      throw new InvalidTypeValueError(`'capabilities' must have at most ${MAX_CAPABILITIES_LENGTH} entries.`, { suggestedTools: ["update_agent"], context: { field: "capabilities", length: sanitized.length } });
    }
    return sanitized;
  }

  private static sanitizeUpdateAllowedEntityTypes(values: unknown): string[] {
    if (!Array.isArray(values)) {
      throw new InvalidTypeValueError("'allowedEntityTypes' must be a string array.", { suggestedTools: ["update_agent"], context: { field: "allowedEntityTypes", received: typeof values } });
    }
    const sanitized: string[] = [];
    for (const e of values) {
      if (typeof e !== "string") {
        throw new InvalidTypeValueError("'allowedEntityType' must be a non-empty string.", { suggestedTools: ["update_agent"], context: { field: "allowedEntityTypes", received: typeof e } });
      }
      const stripped = stripHtmlTags(e.trim());
      if (stripped.length === 0) {
        throw new InvalidTypeValueError("'allowedEntityType' must contain visible characters after HTML sanitization.", { suggestedTools: ["update_agent"], context: { field: "allowedEntityTypes" } });
      }
      if (stripped.length > MAX_ENTITY_LENGTH) {
        throw new InvalidTypeValueError(`'allowedEntityType' exceeds maximum length of ${MAX_ENTITY_LENGTH} characters.`, { suggestedTools: ["update_agent"], context: { field: "allowedEntityTypes", length: stripped.length } });
      }
      sanitized.push(stripped);
    }
    if (sanitized.length > MAX_ALLOWED_ENTITY_TYPES_LENGTH) {
      throw new InvalidTypeValueError(`'allowedEntityTypes' must have at most ${MAX_ALLOWED_ENTITY_TYPES_LENGTH} entries.`, { suggestedTools: ["update_agent"], context: { field: "allowedEntityTypes", length: sanitized.length } });
    }
    return sanitized;
  }

  /** Build the Prisma updateData object from partial UpdateAgentInput.
   *  Extracted from updateAgent to keep its complexity under the lint cap
   *  (round 208). Each branch validates and sanitizes one optional field. */
  private static buildUpdateData(updates: Partial<UpdateAgentInput>): Record<string, unknown> {
    const updateData: Record<string, unknown> = {};
    if (updates.displayName !== undefined) {
      const v = SecurityService.requireStringField(updates.displayName, "displayName", MAX_PARTY_NAME_LENGTH, "update_agent");
      if (stripHtmlTags(v).length === 0) throw new InvalidTypeValueError("'displayName' must contain visible characters after HTML sanitization.", { suggestedTools: ["update_agent"], context: { field: "displayName" } });
      updateData.displayName = stripHtmlTags(v);
    }
    if (updates.description !== undefined) {
      const v = SecurityService.requireStringField(updates.description, "description", MAX_AGENT_DESCRIPTION_LENGTH, "update_agent");
      if (stripHtmlTags(v).length === 0) throw new InvalidTypeValueError("'description' must contain visible characters after HTML sanitization.", { suggestedTools: ["update_agent"], context: { field: "description" } });
      updateData.description = stripHtmlTags(v);
    }
    if (updates.capabilities !== undefined) {
      updateData.capabilities = SecurityService.sanitizeUpdateCapabilities(updates.capabilities);
    }
    if (updates.maxToolCallsPerConversation !== undefined)
      updateData.maxToolCallsPerConversation = updates.maxToolCallsPerConversation;
    if (updates.maxConcurrentConversations !== undefined)
      updateData.maxConcurrentConversations = updates.maxConcurrentConversations;
    if (updates.maxTransactionAmount !== undefined)
      updateData.maxTransactionAmount = updates.maxTransactionAmount;
    if (updates.allowedEntityTypes !== undefined) {
      updateData.allowedEntityTypes = SecurityService.sanitizeUpdateAllowedEntityTypes(updates.allowedEntityTypes);
    }
    if (updates.rateLimitPerMinute !== undefined)
      updateData.rateLimitPerMinute = updates.rateLimitPerMinute;
    if (updates.version !== undefined) {
      const v = SecurityService.requireStringField(updates.version, "version", MAX_VERSION_LENGTH, "update_agent");
      if (stripHtmlTags(v).length === 0) throw new InvalidTypeValueError("'version' must contain visible characters after HTML sanitization.", { suggestedTools: ["update_agent"], context: { field: "version" } });
      updateData.version = stripHtmlTags(v);
    }
    if (updates.isActive !== undefined) updateData.isActive = updates.isActive;
    return updateData;
  }

  async deleteAgent(tenantId: string, agentId: string): Promise<{ success: boolean }> {
    const trimmedTenantId = SecurityService.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "delete_agent");
    const rawAgentId = SecurityService.requireStringField(agentId, "agentId", MAX_AGENT_ID_LENGTH, "delete_agent");
    const validatedAgentId = stripHtmlTags(rawAgentId);
    if (validatedAgentId.length === 0) {
      throw new InvalidTypeValueError("'agentId' must contain visible characters after HTML sanitization.", { suggestedTools: ["delete_agent"], context: { field: "agentId" } });
    }
    try {
      await this.prisma.tenantScoped(trimmedTenantId).agentRegistry.delete({
        where: { agentId_tenantId: { agentId: validatedAgentId, tenantId: trimmedTenantId } },
      });
      this.logger.log(`Deleted agent: ${sanitizeForLogOutput(validatedAgentId)}`);
      return { success: true };
    } catch (err: unknown) {
      throw mapPrismaError(err, "delete_agent", "delete_agent", "agent");
    }
  }

  async getAgent(tenantId: string, agentId: string): Promise<AgentResult> {
    const trimmedTenantId = SecurityService.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "get_agent");
    const rawAgentId = SecurityService.requireStringField(agentId, "agentId", MAX_AGENT_ID_LENGTH, "get_agent");
    const validatedAgentId = stripHtmlTags(rawAgentId);
    if (validatedAgentId.length === 0) {
      throw new InvalidTypeValueError("'agentId' must contain visible characters after HTML sanitization.", { suggestedTools: ["get_agent"], context: { field: "agentId" } });
    }
    let agent;
    try {
      agent = await this.prisma.tenantScoped(trimmedTenantId).agentRegistry.findUnique({
        where: { agentId_tenantId: { agentId: validatedAgentId, tenantId: trimmedTenantId } },
      });
    } catch (err) {
      throw mapPrismaError(err, "get_agent", "get_agent", "agent");
    }
    if (!agent) {
      throw new EntityNotFoundError(
        `Agent '${sanitizeForLogOutput(validatedAgentId)}' not found in tenant '${sanitizeForLogOutput(trimmedTenantId)}'.`,
        { suggestedTools: ["describe_agent", "list_agents"], context: { agentId: validatedAgentId, tenantId: trimmedTenantId } }
      );
    }
    return SecurityService.toAgentResult(agent);
  }

  async searchAgents(input: SearchAgentsInput): Promise<SearchAgentsResult> {
    // `??` (not a destructuring default) so an explicit `null` is defaulted
    // instead of being rejected — the same rule `searchParties` applies.
    const { tenantId, agentId, isActive } = input;
    const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
    const offset = input.offset ?? MIN_SEARCH_OFFSET;

    const trimmedTenantId = SecurityService.requireStringField(tenantId, "tenantId", MAX_TENANT_ID_LENGTH, "search_agents");
    SecurityService.requireIntegerPageParam(limit, "limit", "search_agents");
    SecurityService.requireIntegerPageParam(offset, "offset", "search_agents");
    const validatedLimit = Math.min(Math.max(limit, MIN_SEARCH_LIMIT), MAX_SEARCH_LIMIT);
    const validatedOffset = Math.min(Math.max(offset, MIN_SEARCH_OFFSET), MAX_SEARCH_OFFSET);

    const where: Record<string, unknown> = { tenantId: trimmedTenantId };
    if (agentId !== undefined && agentId !== null) {
      const rawAgentId = SecurityService.requireStringField(agentId, "agentId", MAX_AGENT_ID_LENGTH, "search_agents");
      const strippedAgentId = stripHtmlTags(rawAgentId);
      if (strippedAgentId.length === 0) {
        throw new InvalidTypeValueError("'agentId' must contain visible characters after HTML sanitization.", { suggestedTools: ["search_agents"], context: { field: "agentId" } });
      }
      where.agentId = strippedAgentId;
    }
    if (isActive !== undefined) where.isActive = isActive;

    // Run count first, then findMany with the validated limit. Under READ
    // COMMITTED, concurrent INSERTs between a parallel count+findMany can cause
    // `total` and `items.length` to disagree (worst case: off-by-one in hasMore).
    // Running sequentially avoids this, matching the PartyService/ProductService
    // pattern (round 176).
    let total: number;
    const agentDb = this.prisma.tenantScoped(trimmedTenantId);
    let items: Awaited<ReturnType<typeof agentDb.agentRegistry.findMany>>;
    try {
      total = await agentDb.agentRegistry.count({ where });
      items = await agentDb.agentRegistry.findMany({
        where,
        orderBy: [{ createdAt: "asc" }, { agentId: "asc" }],
        skip: validatedOffset,
        take: validatedLimit,
      });
    } catch (err) {
      throw mapPrismaError(err, "search_agents", "search_agents", "agent");
    }

    return {
      items: items.map((a) => SecurityService.toAgentResult(a)),
      total,
      limit: validatedLimit,
      offset: validatedOffset,
      hasMore: computeHasMore(validatedOffset, validatedLimit, total),
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────

  private static toUserResult(u: {
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

  private static toAgentResult(a: {
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
      maxTransactionAmount: SecurityService.toTransactionAmount(a.maxTransactionAmount),
      allowedEntityTypes: Array.isArray(a.allowedEntityTypes) ? a.allowedEntityTypes : [],
      rateLimitPerMinute: a.rateLimitPerMinute,
      version: a.version,
      isActive: a.isActive,
      createdAt: a.createdAt.toISOString(),
    };
  }

  private static requireStringField(value: unknown, field: string, maxLength: number, tool: string): string {
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

  /**
   * Validate that a value looks like a UUID.
   *
   * `partyId` is the primary key of `Party` (`@default(uuid())`), so it is a
   * UUID. The column is TEXT, so the database will happily store a malformed
   * value and every lookup simply misses — the caller then receives
   * ENTITY_NOT_FOUND instead of the actionable "must be a valid UUID" error
   * every other id field in the codebase produces. Mirrors
   * `PartyService.requireUuid` / `ProductService.requireUuid`.
   */
  private static requireUuid(value: unknown, field: string, suggestedTools: string[]): string {
    if (typeof value !== "string") {
      throw new InvalidTypeValueError(`'${field}' must be a string.`, { suggestedTools, context: { field, received: typeof value } });
    }
    const trimmed = stripHtmlTags(value.trim());
    if (!UUID_REGEX.test(trimmed)) {
      throw new InvalidTypeValueError(
        `'${field}' must be a valid UUID.`,
        { suggestedTools, context: { field, received: sanitizeForLogOutput(trimmed) } }
      );
    }
    return trimmed;
  }

  /**
   * Convert a stored `maxTransactionAmount` into a plain number.
   *
   * The column is a Prisma `Decimal?`, which comes back from the driver as a
   * `Decimal` OBJECT — never a `number`. The previous implementation used
   * `typeof value === "number"`, so the branch was never taken and EVERY
   * agent result reported `maxTransactionAmount: null`, even when a limit
   * had been configured. The agent therefore could not verify that a
   * financial restriction was applied.
   *
   * Delegates to the shared `decimalToNumber` helper, which is also used by
   * the product-price mapper, so the two cannot drift.
   */
  private static toTransactionAmount(value: unknown): number | null {
    return decimalToNumber(value);
  }

  /** Validate that a pagination parameter is a finite integer before clamping.
   *  See searchAgents for why the clamp alone is insufficient. The received
   *  value is stringified when non-finite because JSON.stringify(NaN) → null
   *  would erase the diagnostic detail from the serialized DomainError context.
   *  Mirrors PartyService.requireIntegerPageParam (round 176). */
  private static requireIntegerPageParam(value: number, field: string, tool: string): void {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new InvalidTypeValueError(
        `'${field}' must be a finite integer (received ${String(value)}).`,
        { suggestedTools: [tool], context: { field, received: Number.isFinite(value) ? value : String(value) } }
      );
    }
  }
}
