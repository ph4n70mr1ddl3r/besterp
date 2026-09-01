// Security Types — Input/Output interfaces for the core-security domain.

// ─── User ────────────────────────────────────────────────────────

export interface CreateUserInput {
  tenantId: string;
  partyId: string;
  passwordHash: string;
}

export interface UserResult {
  userId: string;
  partyId: string;
  tenantId: string;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Agent Registry ──────────────────────────────────────────────

export interface RegisterAgentInput {
  agentId: string;
  tenantId: string;
  displayName: string;
  description: string;
  capabilities: string[];
  maxToolCallsPerConversation?: number;
  maxConcurrentConversations?: number;
  maxTransactionAmount?: number;
  allowedEntityTypes?: string[];
  rateLimitPerMinute?: number;
  version: string;
}

export interface UpdateAgentInput {
  agentId: string;
  tenantId: string;
  displayName?: string;
  description?: string;
  capabilities?: string[];
  maxToolCallsPerConversation?: number;
  maxConcurrentConversations?: number;
  maxTransactionAmount?: number;
  allowedEntityTypes?: string[];
  rateLimitPerMinute?: number;
  version?: string;
  isActive?: boolean;
}

export interface AgentResult {
  agentId: string;
  tenantId: string;
  displayName: string;
  description: string;
  capabilities: string[];
  maxToolCallsPerConversation: number;
  maxConcurrentConversations: number;
  maxTransactionAmount: number | null;
  allowedEntityTypes: string[];
  rateLimitPerMinute: number;
  version: string;
  isActive: boolean;
  createdAt: string;
}

export interface SearchAgentsInput {
  tenantId: string;
  agentId?: string;
  isActive?: boolean;
  limit?: number;
  offset?: number;
}

export interface SearchAgentsResult {
  items: AgentResult[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}
