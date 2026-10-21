// Unit tests for the user MCP tools.
//
// `create_user` is the ONLY write path to `user.password_hash` — the table
// that stores the system's only credentials — and it had NO test coverage at
// all: the MCP tool directory contained specs for the agent, discovery, party
// and product tools but not for the user ones.

import { describe, it, expect, vi } from "vitest";
import { registerUserTools } from "./user-tools.js";
import { ToolRegistry, errorHandlerMiddleware } from "@besterp/mcp-tools";

const PARTY_ID = "12345678-1234-1234-1234-123456789abc";
// A syntactically valid bcrypt digest.
const BCRYPT_HASH = "$2b$12$01234567890123456789012345678901234567890123456789012";

function createRegistry() {
  const registry = new ToolRegistry();
  // The error handler is the OUTERMOST middleware in production (see
  // McpService.onModuleInit): it converts every thrown error into a
  // structured ToolResult. Without it a bare registry lets the throw escape.
  registry.addGlobalMiddleware(errorHandlerMiddleware);
  const securityService = {
    createUser: vi.fn().mockResolvedValue({
      userId: "u1",
      partyId: PARTY_ID,
      tenantId: "tenant-1",
      lastLoginAt: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    }),
    getUser: vi.fn().mockResolvedValue({
      userId: "u1",
      partyId: PARTY_ID,
      tenantId: "tenant-1",
      lastLoginAt: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    }),
  };
  registerUserTools(registry);
  return { registry, securityService };
}

const context = {
  tenantId: "tenant-1",
  userId: "user-1",
  services: {} as never,
};

describe("create_user", () => {
  it("rejects a PLAINTEXT password at the tool boundary", async () => {
    // The tool accepted any non-empty string up to 255 characters, so an
    // agent could persist "hunter2" verbatim into the credential column and
    // the tool still reported `success: true`. The agent must get an
    // actionable error AT THE CALL SITE instead.
    const { registry, securityService } = createRegistry();
    const result = await registry.execute(
      "create_user",
      { partyId: PARTY_ID, passwordHash: "hunter2" },
      { ...context, services: { securityService } },
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_INPUT");
    expect(JSON.stringify(result.error)).toContain("bcrypt");
    expect(securityService.createUser).not.toHaveBeenCalled();
  });

  it("rejects a password hash that is not a recognised digest", async () => {
    const { registry, securityService } = createRegistry();
    const result = await registry.execute(
      "create_user",
      { partyId: PARTY_ID, passwordHash: "$2b$12$tooshort" },
      { ...context, services: { securityService } },
    );

    expect(result.success).toBe(false);
    expect(securityService.createUser).not.toHaveBeenCalled();
  });

  it("accepts a bcrypt digest and creates the user", async () => {
    const { registry, securityService } = createRegistry();
    const result = await registry.execute(
      "create_user",
      { partyId: PARTY_ID, passwordHash: BCRYPT_HASH },
      { ...context, services: { securityService } },
    );

    expect(result.success).toBe(true);
    expect(securityService.createUser).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      partyId: PARTY_ID,
      passwordHash: BCRYPT_HASH,
    });
  });

  it("accepts an argon2id digest", async () => {
    const { registry, securityService } = createRegistry();
    const argon2 = "$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$RdescudvJCsgt3ub+b+dWRWJTmaaJObG";
    const result = await registry.execute(
      "create_user",
      { partyId: PARTY_ID, passwordHash: argon2 },
      { ...context, services: { securityService } },
    );

    expect(result.success).toBe(true);
    expect(securityService.createUser).toHaveBeenCalled();
  });

  it("never returns the password hash to the agent", async () => {
    const { registry, securityService } = createRegistry();
    const result = await registry.execute(
      "create_user",
      { partyId: PARTY_ID, passwordHash: BCRYPT_HASH },
      { ...context, services: { securityService } },
    );

    expect(JSON.stringify(result)).not.toContain(BCRYPT_HASH);
  });
});

describe("get_user", () => {
  it("reads the user record for a party", async () => {
    const { registry, securityService } = createRegistry();
    const result = await registry.execute(
      "get_user",
      { partyId: PARTY_ID },
      { ...context, services: { securityService } },
    );

    expect(result.success).toBe(true);
    expect(securityService.getUser).toHaveBeenCalledWith("tenant-1", PARTY_ID);
  });

  it("rejects a malformed partyId", async () => {
    const { registry, securityService } = createRegistry();
    const result = await registry.execute(
      "get_user",
      { partyId: "not-a-uuid" },
      { ...context, services: { securityService } },
    );

    expect(result.success).toBe(false);
    expect(securityService.getUser).not.toHaveBeenCalled();
  });
});

describe("user tools — missing service", () => {
  it("fails with an actionable error when the security service is absent", async () => {
    const { registry } = createRegistry();
    const result = await registry.execute(
      "get_user",
      { partyId: PARTY_ID },
      { ...context, services: {} },
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_TYPE_VALUE");
  });
});
