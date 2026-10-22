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
  getErrorCode,
} from "./errors.js";
import { MAX_SEARCH_OFFSET } from "./constants.js";

/**
 * Extract the error code from a Prisma-like error or return undefined.
 *
 * Delegates to the shared `getErrorCode` helper so there is exactly ONE
 * implementation of "read a machine-readable error code" in the package. The
 * two copies (this one and `getErrorCode` in errors.ts) had drifted apart in
 * style while doing the same thing.
 */
export function getPrismaErrorCode(err: unknown): string | undefined {
  return getErrorCode(err);
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
  // Guard the inputs: a non-finite or negative limit/offset/total would make
  // the comparison below meaningless (e.g. limit = 0 yields
  // `nextOffset === offset`, so `offset < total` advertised a next page that
  // returned the SAME rows forever).
  if (!Number.isFinite(offset) || !Number.isFinite(limit) || !Number.isFinite(total)) return false;
  if (offset < 0 || limit <= 0 || total < 0) return false;
  const nextOffset = offset + limit;
  return nextOffset < total && nextOffset <= MAX_SEARCH_OFFSET;
}

/**
 * Extract the conflicting field name(s) from a Prisma error's metadata.
 * For compound unique constraints `meta.target` is an array of field names;
 * join them so the error message is accurate (e.g. "same tenantId and email"
 * rather than just "same tenantId").
 *
 * Returns `null` when the metadata carries no usable field name. The caller
 * must then phrase the message without a field reference — the previous
 * fallback string ("this record") produced the ungrammatical
 * "A party with the same this record already exists in this tenant."
 */
export function resolveConflictField(err: { meta?: Record<string, unknown> }): string | null {
  const target = err.meta?.target;
  // EVERY element of a compound target must be a string. Checking only
  // `target[0]` let a mixed array through, and `join(" and ")` then stringified
  // the non-string members ("tenantId and 42") — a nonsense field name
  // reflected back to the caller. The MCP error-handler validates every
  // element for the same reason.
  if (Array.isArray(target) && target.length > 0 && target.every((t) => typeof t === "string")) {
    return target.join(" and ");
  }
  // Some Prisma/driver versions report `meta.target` as a bare string.
  if (typeof target === "string" && target.length > 0) {
    return target;
  }
  return null;
}

/**
 * Extract the constraint name from a Prisma error's metadata.
 *
 * Every candidate value is TYPE-CHECKED before it is used. The previous
 * implementation cast the raw metadata values to `string` without checking
 * them, so a `meta.field_name` of `42` was returned as the number 42 and
 * then interpolated into the user-facing message
 * ("Referenced party does not exist (constraint: 42)."). The sibling
 * extractor `resolveConflictField` already validated every element's type
 * for exactly this reason — the two must not disagree.
 */
export function resolveConstraintName(err: { meta?: Record<string, unknown> }): string {
  const fieldName = err.meta?.field_name;
  if (typeof fieldName === "string" && fieldName.length > 0) return fieldName;
  const constraint = err.meta?.constraint;
  if (typeof constraint === "string" && constraint.length > 0) return constraint;
  return "unknown";
}

/**
 * Map a validated Prisma error code to a DomainError. Throws the mapped error.
 */
export function throwMappedPrismaError(
  code: string,
  err: Error & { code: string; meta?: Record<string, unknown> },
  retryTool: string,
  suggestTool: string,
  entityName: string,
): never {
  switch (code) {
    case "P2002": {
      const field = resolveConflictField(err);
      throw new DuplicateEntityError(
        field
          ? `A ${entityName} with the same ${field} already exists in this tenant.`
          : `A ${entityName} with the same unique key already exists in this tenant.`,
        { suggestedTools: [suggestTool], context: { prismaCode: "P2002", conflictingField: field ?? "unknown" } }
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
    default: {
      // Re-throw unknown Prisma codes (e.g. future P3xxx, P4xxx) as the
      // original error so the filter returns 500 instead of misreporting
      // a transient infrastructure failure as a caller-input 422.
      //
      // P2024 ("timed out fetching a connection from the pool") falls into
      // this branch deliberately. It used to be mapped to
      // ConcurrencyConflictError, but a pool timeout is a CONNECTION
      // failure, exactly like P1002 ("timed out fetching a new connection
      // from the connection pool") — and P1002 is re-thrown as an
      // infrastructure failure. The two codes describe the SAME failure,
      // yet the REST surface answered 409 for one and 500 for the other,
      // while the MCP surface answered DATABASE_CONNECTION_ERROR for BOTH.
      // Re-throwing makes every surface agree: a pool timeout is a
      // retryable server-side failure, not a conflict with the caller's
      // input.
      //
      // The original error is re-thrown only when it really is an Error.
      // The parameter is typed as `Error & { code }`, but a caller could
      // still pass a plain object; throwing a non-Error breaks every
      // downstream `instanceof Error` check (the REST filter's
      // `isDomainError` / `instanceof HttpException` dispatch and
      // `DomainError` handling both rely on it), so a non-Error is wrapped.
      if (err instanceof Error) throw err;
      throw new InvalidTypeValueError(
        `Unexpected database error while processing ${entityName}.`,
        { suggestedTools: [suggestTool], context: { prismaCode: code } }
      );
    }
  }
}

/**
 * Re-throw a database failure, guaranteeing the thrown value is an Error.
 *
 * `handleTransactionError` re-throws the original error for failures it
 * cannot map (an unrecognised Prisma code, a P1xxx connection failure, an
 * error with no code at all) so the REST filter answers a generic 500
 * instead of misreporting an infrastructure failure as a caller-input 422.
 *
 * The original value could be a plain OBJECT rather than an Error (the
 * parameter is typed `unknown`, and a driver CAN reject with a
 * non-Error value). Throwing a non-Error breaks every downstream
 * `instanceof Error` check — the REST filter's `isDomainError` /
 * `instanceof HttpException` dispatch and the MCP error-handler's
 * `getErrorCode` extraction both rely on it — so the value is wrapped.
 * The original is preserved as the `cause` for diagnostics.
 */
function rethrowAsError(err: unknown): never {
  if (err instanceof Error) throw err;
  throw new Error("Unexpected database error.", { cause: err });
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
    // A null/primitive failure is an INTERNAL fault (the database layer
    // rejected with a value that is not an error at all), NOT a malformed
    // request. It used to be reported as InvalidTypeValueError, which the
    // REST filter maps to 422 — "your input was wrong" — for a failure the
    // caller could not possibly have caused, and which the same function
    // deliberately avoids for P1xxx outages twenty lines below. A plain
    // Error is reported as a generic 500, consistent with that policy.
    throw new Error(
      `Database operation failed with an unexpected error type while processing ${entityName}.`,
      { cause: err },
    );
  }

  const code = getPrismaErrorCode(err);
  if (!code) rethrowAsError(err);
  if (!/^P\d{4}$/.test(code)) rethrowAsError(err);
  if (/^P1\d{3}$/.test(code)) rethrowAsError(err);

  return throwMappedPrismaError(code, err as Error & { code: string; meta?: Record<string, unknown> }, retryTool, suggestTool, entityName);
}
