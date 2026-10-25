// User MCP Tools — Tool definitions for the human-user half of the
// core-security domain.
//
// The agent registry half of `SecurityService` had six MCP tools, but the
// USER half had none: `createUser`, `getUser` and `updateLastLogin` had no
// caller at all. `createUser` is the ONLY write path to the `user` table —
// the table that stores `password_hash` — so the domain was entirely
// unreachable: there was no way to provision a user account at all.
//
// The tools below expose the two operations an agent legitimately needs:
// reading a user record, and provisioning one for an existing party.

import { z } from "zod";
import {
  ToolRegistry,
  ToolDefinition,
  ToolContext,
  uuidParam,
} from "@besterp/mcp-tools";
import {
  InvalidTypeValueError,
  MAX_PASSWORD_HASH_LENGTH,
  isSupportedPasswordHash,
  MAX_IDEMPOTENCY_KEY_LENGTH,
} from "@besterp/shared";
import type {
  CreateUserInput,
  UserResult,
} from "../../modules/core/security/security.types.js";

interface SecurityServices {
  securityService: {
    createUser(input: CreateUserInput): Promise<UserResult>;
    getUser(tenantId: string, partyId: string): Promise<UserResult>;
  };
}

function getUserService(ctx: ToolContext) {
  const svc = ctx.services.securityService;
  if (svc === undefined || svc === null || typeof svc !== "object") {
    throw new InvalidTypeValueError(
      "SecurityService not available in ToolContext.services",
      { suggestedTools: ["list_available_tools"], context: { field: "securityService" } }
    );
  }
  const requiredMethods: (keyof SecurityServices["securityService"])[] = [
    "createUser", "getUser",
  ];
  for (const method of requiredMethods) {
    if (typeof (svc as SecurityServices["securityService"])[method] !== "function") {
      throw new InvalidTypeValueError(
        `SecurityService in ToolContext.services is missing required method '${method}'`,
        { suggestedTools: ["list_available_tools"], context: { field: "securityService", missingMethod: method } }
      );
    }
  }
  return svc as SecurityServices["securityService"];
}

// ─── Tool: get_user ──────────────────────────────────────────────

const getUser: ToolDefinition = {
  name: "get_user",
  description: `Get the user account linked to a party.

A user account is the auth-specific half of a party: the party carries the
identity, the user row carries the credential and the login history. The
password hash is NEVER returned.

Use 'search_parties' to find the party's partyId first.`,

  inputSchema: z.strictObject({
    partyId: uuidParam("The UUID of the party whose user account to read"),
  }),

  riskLevel: "none",
  entity: "user",
  relatedTools: { get: "get_user", search: "search_parties" },
  tags: ["user", "read", "security"],

  handler: async (inputRaw: unknown, context: ToolContext) => {
    const input = inputRaw as { partyId: string };
    const svc = getUserService(context);
    const user = await svc.getUser(context.tenantId, input.partyId);
    return {
      success: true,
      data: user,
      nextActions: [
        "Use 'get_party' to see the party's full identity and contact details.",
      ],
    };
  },
};

// ─── Tool: create_user ───────────────────────────────────────────

const createUser: ToolDefinition = {
  name: "create_user",
   description: `Create a user account for an existing party.

   The party must already exist — use 'search_parties' and 'get_party' first.
   The passwordHash must be a HASH (e.g. a bcrypt or argon2 digest) produced by
   the authentication service, never a plaintext password: this tool does not
   hash, and a plaintext password would be persisted as the hash.

   The password hash is never returned by this tool, and it is redacted from the
   durable audit trail.

   For idempotent writes, pass an idempotencyKey (string, max ${MAX_IDEMPOTENCY_KEY_LENGTH} chars) along with the tool arguments. If the same key is used again, the operation will be safely replayed or deduplicated.`,

  inputSchema: z.strictObject({
    partyId: uuidParam("The UUID of the party to create the user account for"),
    passwordHash: z.string()
      .min(1)
      .max(MAX_PASSWORD_HASH_LENGTH)
      // The hash must LOOK like a hash. Without this check the tool accepted
      // any non-empty string up to 255 characters, so a plaintext password
      // was persisted verbatim into `user.password_hash` — the only
      // credential store in the schema — and the tool still reported
      // `success: true`. The check is a SHAPE check (bcrypt / argon2), so
      // the agent gets an actionable error at the call site instead of a
      // silently-stored plaintext credential.
      .refine(isSupportedPasswordHash, {
        message:
          "passwordHash must be a bcrypt ($2a$/$2b$/$2y$...) or argon2 ($argon2id$...) digest — never a plaintext password.",
      })
      .describe("The already-hashed password (bcrypt or argon2 digest; never a plaintext password)"),
  }),

  riskLevel: "high",
  entity: "user",
  relatedTools: { get: "get_user", search: "search_parties" },
  tags: ["user", "create", "security"],

  handler: async (inputRaw: unknown, context: ToolContext) => {
    const input = inputRaw as { partyId: string; passwordHash: string };
    const svc = getUserService(context);
    const user = await svc.createUser({
      tenantId: context.tenantId,
      partyId: input.partyId,
      passwordHash: input.passwordHash,
    });
    return {
      success: true,
      data: user,
      nextActions: [
        "Use 'get_user' with the partyId to review the new user account.",
      ],
    };
  },
};

// ─── Registration ─────────────────────────────────────────────────

export function registerUserTools(registry: ToolRegistry): void {
  registry.register(getUser);
  registry.register(createUser);
}
