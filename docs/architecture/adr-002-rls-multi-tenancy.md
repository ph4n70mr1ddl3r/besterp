# ADR-002: Row-Level Security (RLS) for Multi-Tenancy

**Status:** Accepted  
**Date:** 2026-05-10  
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

### Implementation pattern:

```sql
-- Every tenant-scoped table gets a tenant_id column
ALTER TABLE party ADD COLUMN tenant_id UUID NOT NULL;
ALTER TABLE party ADD CONSTRAINT fk_tenant 
  FOREIGN KEY (tenant_id) REFERENCES organization(party_id);

-- Enable RLS on the table
ALTER TABLE party ENABLE ROW LEVEL SECURITY;

-- Create policy: users can only see their own tenant's data
CREATE POLICY tenant_isolation ON party
  USING (tenant_id = current_setting('app.current_tenant')::UUID);
```

### Application-level enforcement:

```typescript
// Every database connection sets the tenant context
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const tenantId = req.user.tenantId; // From JWT / session
    await prisma.$executeRaw`SET LOCAL app.current_tenant = ${tenantId}`;
    next();
  }
}
```

### Tenant resolution flow:

```
Request → Auth (extract user) → Resolve tenant from USER → PARTY_ROLE → ORGANIZATION
  → SET app.current_tenant → Proceed with query
```

### Tables exempt from RLS:
- System-level type tables (PARTY_TYPE, ORDER_TYPE, etc.) — shared across all tenants
- `entity_descriptor` — shared schema descriptions
- `ai_action_log` — scoped to tenant via explicit `tenant_id` column
- `confirmation_gate` — gate definitions are per-tool, not per-tenant (configurable per tenant via override table)

## Alternatives Considered

| Alternative | Pros | Cons | Verdict |
|-------------|------|------|---------|
| **Schema-per-tenant** | Strong isolation, flexible per-tenant schemas | Migration complexity (N schemas), connection pool exhaustion, hard to query across tenants | ❌ Too much operational overhead |
| **Database-per-tenant** | Maximum isolation | Highest cost, migration nightmare, cross-tenant analytics impossible | ❌ Too expensive for early stage |
| **Row-Level Security** | One database, one migration, good isolation | Slight query overhead, must be vigilant about every query | ✅ Best balance |
| **Application-level filtering** | No DB dependency | Every developer must remember to filter, one missed filter = data leak | ❌ Too risky |

## Consequences

### Positive
- Single database, single migration path
- Strong data isolation enforced at the database level (not just application code)
- Easy to add tenants (just insert an ORGANIZATION row)
- Cross-tenant analytics possible for platform operators (by disabling RLS in admin sessions)

### Negative
- Every query must be tenant-aware — forgetting to set `app.current_tenant` returns no data (safe failure mode, but confusing)
- RLS adds ~5-15% overhead on queries (benchmark needed for our workload)
- Prisma support for RLS is not native — requires raw SQL for `SET LOCAL`
- Connection pooling must be compatible with session-level variables (PgBouncer in session mode, or use connection pinning)

### Mitigations
- Write a Prisma middleware / extension that automatically sets `app.current_tenant` on every connection
- Add integration tests that verify tenant isolation (insert data as tenant A, verify tenant B can't see it)
- Benchmark RLS overhead during Phase 0 spike
- Use Prisma Client Extensions for RLS integration (supported since Prisma 4.16+)

## References

- [PostgreSQL Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [Prisma Client Extensions for RLS](https://www.prisma.io/docs/concepts/components/prisma-client/client-extensions)
- ERP_PLAN.md — Section 2 (core-party maps to ORGANIZATION for tenancy)
