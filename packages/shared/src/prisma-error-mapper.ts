// Shared Prisma error mapping and pagination utilities.
//
// Extracted from party.service.ts, product.service.ts, and security.service.ts
// to eliminate three identical copies of the same error-code mapping logic and
// the identical hasMore computation. All three services now import these
// instead of re-implementing them locally, so a future Prisma error code
// change only needs a single edit.

import {
  DuplicateEntityError,
  EntityNotFoundError,
  ConcurrencyConflictError,
  InvalidTypeValueError,
} from "./errors.js";
import { MAX_SEARCH_OFFSET } from "./constants.js";

/**
 * Extract the error code from a Prisma-like error or return undefined.
 * Uses duck-typing instead of instanceof to survive Proxy-wrapped tenant
 * clients (rls-extension.ts) that break Symbol.hasInstance checks.
 */
export function getPrismaErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string") {
    return (err as { code: string }).code;
  }
  return undefined;
}

/**
 * Compute the hasMore flag for paginated search results.
 *
 * The "next offset" a client computes (offset + limit) must itself be a valid
 * offset within MAX_SEARCH_OFFSET, otherwise it is rejected by the boundary
 * layers (REST DTO @Max, MCP Zod max) even when hasMore hints at it. Without
 * this cap, a tenant with more than MAX_SEARCH_OFFSET + limit rows gets
 * hasMore=true forever while every suggested next offset 400s — a dead-end
 * pagination loop (round 151). Rows beyond MAX_SEARCH_OFFSET + limit are
 * unreachable by design (offset capping), so reporting hasMore=false at that
 * boundary is the correct ceiling.
 */
export function computeHasMore(offset: number, limit: number, total: number): boolean {
  const nextOffset = offset + limit;
  return nextOffset < total && nextOffset <= MAX_SEARCH_OFFSET;
}

/**
 * Extract the conflicting field name(s) from a Prisma error's metadata.
 * For compound unique constraints `meta.target` is an array of field names;
 * join them so the error message is accurate (e.g. "same tenantId and email"
 * rather than just "same tenantId").
 */
export function resolveConflictField(err: { meta?: Record<string, unknown> }): string {
  const target = err.meta?.target;
  if (Array.isArray(target) && target.length > 0 && typeof target[0] === "string") {
    return target.join(" and ");
  }
  return "this record";
}

/**
 * Extract the constraint name from a Prisma error's metadata.
 */
export function resolveConstraintName(err: { meta?: Record<string, unknown> }): string {
  return (err.meta?.field_name as string | undefined)
    ?? (err.meta?.constraint as string | undefined)
    ?? "unknown";
}

/**
 * Map a validated Prisma error code to a DomainError. Throws the mapped error.
 */
export function throwMappedPrismaError(
  code: string,
  err: { code: string; meta?: Record<string, unknown> },
  retryTool: string,
  suggestTool: string,
  entityName: string,
): never {
  switch (code) {
    case "P2002": {
      const field = resolveConflictField(err);
      throw new DuplicateEntityError(
        `A ${entityName} with the same ${field} already exists in this tenant.`,
        { suggestedTools: [suggestTool], context: { prismaCode: "P2002", conflictingField: field } }
      );
    }
    case "P2003": {
      const constraint = resolveConstraintName(err);
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
        { suggestedTools: [retryTool], context: { prismaCode: "P2024" } }
      );
    }
    default: {
      // Re-throw unknown Prisma codes (e.g. future P3xxx, P4xxx) as the
      // original error so the filter returns 500 instead of misreporting
      // a transient infrastructure failure as a caller-input 422.
      throw err;
    }
  }
}

/**
 * Map Prisma transaction errors to DomainErrors. Throws the mapped error.
 *
 * Belt-and-suspenders: if err is null/undefined/non-object, wrap it so
 * downstream callers always receive a proper Error (never a thrown null).
 *
 * ConcurrencyRetryError is not a DomainError and should propagate as-is
 * so the caller's retry loop can catch it. Do NOT map it here.
 *
 * P1xxx codes are connection/engine-level failures (P1000 auth failed,
 * P1001 can't reach the database, P1002 timed out, P1017 server closed the
 * connection). These are infrastructure failures, not caller-input errors:
 * mapping them to InvalidTypeValueError would surface a transient DB
 * outage to clients as "your input was wrong" (422) instead of a
 * retryable server error. Re-throw the original error so the REST filter
 * returns a generic 500 and the MCP error-handler treats it as a
 * server-side failure.
 */
export function handleTransactionError(
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

  const code = getPrismaErrorCode(err);
  if (!code) throw err;
  if (!/^P\d{4}$/.test(code)) throw err;
  if (/^P1\d{3}$/.test(code)) throw err;

  return throwMappedPrismaError(code, err as { code: string; meta?: Record<string, unknown> }, retryTool, suggestTool, entityName);
}
