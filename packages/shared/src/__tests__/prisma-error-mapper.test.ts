import { describe, it, expect } from "vitest";
import {
  getPrismaErrorCode,
  computeHasMore,
  resolveConflictField,
  resolveConstraintName,
  throwMappedPrismaError,
  handleTransactionError,
} from "../prisma-error-mapper.js";
import { DomainError, InvalidTypeValueError, DuplicateEntityError, EntityNotFoundError, ConcurrencyConflictError } from "../errors.js";

/** A Prisma-like error: an Error carrying a machine-readable `code`. */
class FakePrismaError extends Error {
  constructor(
    readonly code: string,
    meta?: Record<string, unknown>,
  ) {
    super(`prisma ${code}`);
    this.name = "PrismaClientKnownRequestError";
    if (meta) (this as { meta?: Record<string, unknown> }).meta = meta;
  }
}

describe("getPrismaErrorCode", () => {
  it("reads the code off a Prisma-like error", () => {
    expect(getPrismaErrorCode(new FakePrismaError("P2002"))).toBe("P2002");
  });

  it("returns undefined for a value with no code", () => {
    expect(getPrismaErrorCode(new Error("boom"))).toBeUndefined();
    expect(getPrismaErrorCode(null)).toBeUndefined();
  });
});

describe("resolveConflictField", () => {
  it("joins a compound target", () => {
    expect(resolveConflictField({ meta: { target: ["tenantId", "email"] } })).toBe("tenantId and email");
  });

  it("accepts a bare string target", () => {
    expect(resolveConflictField({ meta: { target: "sku" } })).toBe("sku");
  });

  it("returns null when the target is missing or contains non-strings", () => {
    expect(resolveConflictField({})).toBeNull();
    expect(resolveConflictField({ meta: {} })).toBeNull();
    expect(resolveConflictField({ meta: { target: [] } })).toBeNull();
    // A mixed array must not be stringified into "tenantId and 42".
    expect(resolveConflictField({ meta: { target: ["tenantId", 42] } })).toBeNull();
  });
});

describe("resolveConstraintName", () => {
  it("prefers field_name, then constraint", () => {
    expect(resolveConstraintName({ meta: { field_name: "party_role_party_id_fkey" } })).toBe("party_role_party_id_fkey");
    expect(resolveConstraintName({ meta: { constraint: "user_tenant_party_unique" } })).toBe("user_tenant_party_unique");
    expect(resolveConstraintName({ meta: { field_name: "a", constraint: "b" } })).toBe("a");
  });

  it("falls back to \"unknown\" when the metadata carries no usable name", () => {
    expect(resolveConstraintName({})).toBe("unknown");
    expect(resolveConstraintName({ meta: {} })).toBe("unknown");
  });

  it("ignores NON-STRING metadata values", () => {
    // The values used to be cast to `string` without a type check, so a
    // numeric `field_name` was returned as the number 42 and interpolated
    // into the user-facing message ("…(constraint: 42).").
    expect(resolveConstraintName({ meta: { field_name: 42 } })).toBe("unknown");
    expect(resolveConstraintName({ meta: { constraint: 7 } })).toBe("unknown");
    expect(resolveConstraintName({ meta: { field_name: {} } })).toBe("unknown");
    expect(resolveConstraintName({ meta: { field_name: "" } })).toBe("unknown");
  });
});

describe("computeHasMore", () => {
  it("computes the next-page flag", () => {
    expect(computeHasMore(0, 50, 50)).toBe(false);
    expect(computeHasMore(0, 50, 51)).toBe(true);
    expect(computeHasMore(0, 50, 100)).toBe(true);
    expect(computeHasMore(50, 50, 100)).toBe(false);
  });

  it("returns false for nonsensical inputs", () => {
    expect(computeHasMore(0, 0, 100)).toBe(false);
    expect(computeHasMore(-1, 50, 100)).toBe(false);
    expect(computeHasMore(0, 50, -1)).toBe(false);
    expect(computeHasMore(Number.NaN, 50, 100)).toBe(false);
  });
});

describe("throwMappedPrismaError", () => {
  it("maps P2002 to a duplicate-entity error naming the conflicting field", () => {
    try {
      throwMappedPrismaError("P2002", new FakePrismaError("P2002", { target: ["tenantId", "email"] }) as never, "search_parties", "create_party", "party");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DuplicateEntityError);
      expect((err as Error).message).toContain("tenantId and email");
    }
  });

  it("maps P2003 to an invalid-type error naming the constraint", () => {
    try {
      throwMappedPrismaError("P2003", new FakePrismaError("P2003", { constraint: "user_tenant_party_unique" }) as never, "get_user", "create_user", "user");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTypeValueError);
      expect((err as Error).message).toContain("user_tenant_party_unique");
    }
  });

  it("maps P2025 to a not-found error and P2028/P2034 to a conflict", () => {
    for (const code of ["P2025"]) {
      expect(() =>
        throwMappedPrismaError(code, new FakePrismaError(code) as never, "search_parties", "create_party", "party"),
      ).toThrow(EntityNotFoundError);
    }
    for (const code of ["P2028", "P2034"]) {
      expect(() =>
        throwMappedPrismaError(code, new FakePrismaError(code) as never, "search_parties", "create_party", "party"),
      ).toThrow(ConcurrencyConflictError);
    }
  });

  it("re-throws P2024 (connection pool timeout) unchanged, like every other pool failure", () => {
    // P2024 and P1002 describe the SAME failure — a connection that could not
    // be taken from the pool. P1002 is re-thrown as an infrastructure
    // failure, so the REST surface answers 500 and the MCP surface answers
    // DATABASE_CONNECTION_ERROR. P2024 used to be mapped to
    // ConcurrencyConflictError, so the REST surface answered 409 for one code
    // and 500 for the other while the MCP surface answered
    // DATABASE_CONNECTION_ERROR for both.
    const poolTimeout = new FakePrismaError("P2024");
    try {
      throwMappedPrismaError("P2024", poolTimeout as never, "search_parties", "create_party", "party");
      expect.unreachable();
    } catch (err) {
      expect(err).toBe(poolTimeout);
      expect(err).not.toBeInstanceOf(DomainError);
    }
  });
});

describe("handleTransactionError", () => {
  it("maps a known Prisma code to the matching domain error", () => {
    expect(() => handleTransactionError(new FakePrismaError("P2002"), "search_parties", "create_party")).toThrow(DuplicateEntityError);
    expect(() => handleTransactionError(new FakePrismaError("P2025"), "search_parties", "create_party")).toThrow(EntityNotFoundError);
    expect(() => handleTransactionError(new FakePrismaError("P2003"), "search_parties", "create_party")).toThrow(InvalidTypeValueError);
  });

  it("re-throws a P1xxx connection failure unchanged so it surfaces as a 500", () => {
    // P1xxx codes are infrastructure failures. Mapping them to
    // InvalidTypeValueError would tell the caller "your input was wrong"
    // (422) for a transient database outage.
    const outage = new FakePrismaError("P1001");
    try {
      handleTransactionError(outage, "search_parties", "create_party");
      expect.unreachable();
    } catch (err) {
      expect(err).toBe(outage);
      expect(err).not.toBeInstanceOf(DomainError);
    }
  });

  it("re-throws an unmapped Prisma code unchanged", () => {
    const unknown = new FakePrismaError("P3999");
    try {
      handleTransactionError(unknown, "search_parties", "create_party");
      expect.unreachable();
    } catch (err) {
      expect(err).toBe(unknown);
    }
  });

  it("always throws an Error, never a raw non-Error value", () => {
    // The parameter is `unknown` and a driver CAN reject with a plain
    // object. Throwing a non-Error breaks every downstream `instanceof
    // Error` check (the REST filter's dispatch and the MCP error-handler's
    // code extraction both rely on it).
    const plainObject = { code: "P1001" };
    try {
      handleTransactionError(plainObject, "search_parties", "create_party");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).cause).toBe(plainObject);
    }
  });

  it("reports a null/primitive failure as an internal error, not a client error", () => {
    // A null failure is an INTERNAL fault, not a malformed request. It used
    // to be thrown as InvalidTypeValueError, which the REST filter maps to
    // 422 ("your input was wrong") for something the caller could not have
    // caused.
    for (const bad of [null, undefined, "boom", 42]) {
      try {
        handleTransactionError(bad, "search_parties", "create_party");
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(DomainError);
      }
    }
  });
});

describe("handleTransactionError — caller-input Prisma codes", () => {
  it("maps a value-too-long / null-constraint / out-of-range failure to a 422-shaped domain error", () => {
    // These describe a request the CALLER got wrong. The MCP surface already
    // answered them with an actionable error; the REST surface re-threw them
    // unchanged, so the filter answered 500 INTERNAL_ERROR for the very same
    // failure and the client retried a request that could never succeed.
    for (const code of ["P2000", "P2011", "P2012", "P2014", "P2016", "P2017", "P2019", "P2020"]) {
      const err = Object.assign(new Error("boom"), { code });
      try {
        handleTransactionError(err, "get_party", "search_parties", "party");
        throw new Error(`expected ${code} to be mapped`);
      } catch (thrown) {
        expect(thrown, `${code} was not mapped`).toBeInstanceOf(InvalidTypeValueError);
      }
    }
  });

  it("maps a missing-required-record failure to a not-found domain error", () => {
    for (const code of ["P2013", "P2018"]) {
      const err = Object.assign(new Error("boom"), { code });
      try {
        handleTransactionError(err, "get_party", "search_parties", "party");
        throw new Error(`expected ${code} to be mapped`);
      } catch (thrown) {
        expect(thrown, `${code} was not mapped`).toBeInstanceOf(EntityNotFoundError);
      }
    }
  });

  it("still re-throws an infrastructure failure (P1xxx) unchanged", () => {
    const err = Object.assign(new Error("db down"), { code: "P1001" });
    expect(() => handleTransactionError(err, "get_party", "search_parties", "party")).toThrow(err);
  });
});
