# ADR-002: Row-Level Security (RLS) for Multi-Tenancy

**Status:** Accepted  
**Date:** 2026-05-10  
**Updated:** 2026-05-10 — Spike findings incorporated  
**Deciders:** Architecture team  
**Related:** ERP_PLAN.md Section 7, Decision 3

---

## Context

BestERP is multi-tenant from day one. Each tenant (an ORGANIZATION in the Party model) must have isolated data. We need a multi-tenancy strategy that balances:

- **Isolation** — tenants must never see each other's data
- **Cost** — operating one database is cheaper than many
- **Operational simplicity** — migrations run once, not per-tenant
- **Query performance** — tenant filtering must not add significant overhead

## Decision

We use **PostgreSQL Row-Level Security (RLS)** with a `tenant_id` column on every tenant-scoped table.

### Database roles (dual-role pattern)

> ⚠️ **Critical:** PostgreSQL superusers **always bypass RLS**, even with `FORCE ROW LEVEL SECURITY`. This is by design and cannot be overridden. We must use two database roles:

| Role | Purpose | RLS | Used by |
|------|---------|-----|---------|
| `besterp` (superuser) | Migrations, admin operations, cross-tenant analytics | **Bypassed** | Prisma migrate, admin scripts, spike cleanup |
| `besterp_app` (non-superuser) | All application runtime queries | **Enforced** | NestJS API, MCP tool server, agent operations |

Role creation (must run after database provisioning):
```sql
CREATE ROLE besterp_app WITH LOGIN PASSWORD 'besterp_app_dev' NOINHERIT;
GRANT CONNECT ON DATABASE besterp TO besterp_app;
GRANT USAGE ON SCHEMA public TO besterp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO besterp_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO besterp_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO besterp_app;
```

### RLS policy pattern

Every tenant-scoped table needs **both** `USING` and `WITH CHECK` clauses:

```sql
-- Enable and FORCE RLS (FORCE ensures even table owner is restricted)
ALTER TABLE party ENABLE ROW LEVEL SECURITY;
ALTER TABLE party FORCE ROW LEVEL SECURITY;

-- USING  = rows visible for SELECT, UPDATE, DELETE
-- WITH CHECK = rows allowed for INSERT, UPDATE
-- BOTH are required — omitting WITH CHECK causes writes to fail with
-- "new row violates row-level security policy"
CREATE POLICY tenant_isolation ON party
  USING (tenant_id = current_setting('app.current_tenant', TRUE))
  WITH CHECK (tenant_id = current_setting('app.current_tenant', TRUE));
```

> **Note:** `current_setting(..., TRUE)` returns NULL (not an error) when the setting is unset. An unset `app.current_tenant` means **no rows are visible** — safe failure mode.

### Application-level enforcement

`SET LOCAL` only persists within the current transaction. It cannot be set in middleware and then used in a separate query. The correct pattern is **wrapping queries in interactive transactions**:

```typescript
// ✅ Correct: SET LOCAL + query in same transaction
async function withTenant<T>(
  prisma: PrismaClient,
  tenantId: string,
  fn: (tx: PrismaClient) => Promise<T>
): Promise<T> {
  // Validate tenantId to prevent SQL injection
  // (SET LOCAL doesn't support Prisma parameterized queries)
  if (!/^[a-zA-Z0-9_-]+$/.test(tenantId)) {
    throw new Error(`Invalid tenant ID: ${tenantId}`);
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SET LOCAL app.current_tenant = '${tenantId}'`
    );
    return fn(tx as unknown as PrismaClient);
  });
}

// ❌ Wrong: SET LOCAL in middleware, query runs later in a different transaction
// SET LOCAL only lasts until the end of the current transaction/block
//
// ❌ Wrong: Prisma tagged template for SET LOCAL
// $executeRaw`SET LOCAL app.current_tenant = ${tenantId}` 
// fails because SET LOCAL doesn't support $1 parameter syntax
```

### Connection string configuration

```
# Application role (non-superuser, subject to RLS)
DATABASE_URL="postgresql://besterp_app:***@host:5432/besterp"

# Admin role (superuser, bypasses RLS — for migrations only)
DATABASE_ADMIN_URL="postgresql://besterp:***@host:5432/besterp"
```

### Tenant resolution flow:

```
Request → Auth (extract user) → Resolve tenant from USER → PARTY_ROLE → ORGANIZATION
  → withTenant(tenantId, (tx) => { ... }) → SET LOCAL + query in same transaction
```

### Tables exempt from RLS:
- System-level type tables (PARTY_TYPE, ORDER_TYPE, ROLE_TYPE, etc.) — shared across all tenants
- `entity_descriptor` — shared schema descriptions
- `confirmation_gate` — gate definitions are per-tool, not per-tenant (configurable per tenant via override table)

Tables **with** RLS:
- `party`, `contact_mechanism`, `party_contact_mechanism` — tenant-scoped
- `ai_action_log` — tenant-scoped via `tenant_id` column
- `idempotency_record` — tenant-scoped via `tenant_id` column

## Alternatives Considered

| Alternative | Pros | Cons | Verdict |
|-------------|------|------|---------|
| **Schema-per-tenant** | Strong isolation, flexible per-tenant schemas | Migration complexity (N schemas), connection pool exhaustion, hard to query across tenants | ❌ Too much operational overhead |
| **Database-per-tenant** | Maximum isolation | Highest cost, migration nightmare, cross-tenant analytics impossible | ❌ Too expensive for early stage |
| **Row-Level Security** | One database, one migration, good isolation | Slight query overhead, must be vigilant about every query | ✅ Best balance |
| **Application-level filtering** | No DB dependency | Every developer must remember to filter, one missed filter = data leak | ❌ Too risky |

## Spike Validation Results (Phase 0a)

| Test | Result |
|------|--------|
| Prisma + RLS via SET LOCAL | ✅ Works inside `$transaction` |
| Tenant A cannot see Tenant B's data | ✅ Confirmed — complete isolation |
| Pure RLS query overhead | ✅ ~0% (negligible) |
| Transaction wrapping overhead | ⚠️ ~125% vs raw query (0.64ms → 1.45ms per query) |
| WITH CHECK required for writes | ✅ Confirmed — INSERT/UPDATE fails without it |
| Superuser bypasses RLS | ✅ Confirmed — must use non-superuser app role |

**Performance note:** The real cost is the `$transaction` wrapper, not RLS itself. For production, we should set tenant context once per HTTP request (via connection pinning or Prisma Client Extension) instead of per-query.

## Consequences

### Positive
- Single database, single migration path
- Strong data isolation enforced at the database level (not just application code)
- Easy to add tenants (just insert an ORGANIZATION row)
- Cross-tenant analytics possible for platform operators (by using admin connection)
- RLS itself is essentially free — ~0% overhead on queries

### Negative
- Every query must be tenant-aware — forgetting to set `app.current_tenant` returns no data (safe failure mode, but confusing during development)
- Requires two database roles (admin + app) — adds setup complexity
- Transaction wrapping adds ~0.8ms per query (the cost of `SET LOCAL` + transaction overhead, not RLS)
- Prisma support for RLS is not native — requires `$transaction` + raw SQL for `SET LOCAL`
- Connection pooling must be compatible with session-level variables (PgBouncer in session mode, or use connection pinning)

### Mitigations
- Create a Prisma Client Extension that wraps all operations in `withTenant()` automatically
- Add integration tests that verify tenant isolation (insert data as tenant A, verify tenant B can't see it)
- Set tenant context once per HTTP request via middleware, not per-query
- Use the admin role only for migrations and cross-tenant admin operations

## References

- [PostgreSQL Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [PostgreSQL CREATE POLICY (USING / WITH CHECK)](https://www.postgresql.org/docs/current/sql-createpolicy.html)
- [Prisma Client Extensions for RLS](https://www.prisma.io/docs/concepts/components/prisma-client/client-extensions)
- [Prisma $transaction (interactive)](https://www.prisma.io/docs/concepts/components/prisma-client/transactions#interactive-transactions)
- ERP_PLAN.md — Section 2 (core-party maps to ORGANIZATION for tenancy)
