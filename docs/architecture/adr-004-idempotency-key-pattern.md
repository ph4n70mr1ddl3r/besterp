# ADR-004: Idempotency Key Pattern for Write Tools

**Status:** Accepted  
**Date:** 2026-05-10  
**Deciders:** Architecture team  
**Related:** AGENTIC_AI_DESIGN.md Principle 4

---

## Context

AI agents may:
- Retry a tool call if they get a timeout or unclear error
- Be interrupted mid-workflow and resume
- Call the same operation from multiple reasoning paths
- Experience network issues and resend

Without idempotency, a retried `create_invoice` could create duplicate invoices. In an ERP, this is a **data integrity disaster**.

## Decision

**Every write tool (create, update, transition, compound) must accept an `idempotencyKey` parameter.** The system stores the key and result for a configurable TTL. Replaying the same key returns the original result without re-executing.

### Storage:

```sql
CREATE TABLE idempotency_record (
  idempotency_key TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  agent_id TEXT,
  conversation_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | completed | failed
  input_hash TEXT NOT NULL,                -- SHA-256 of tool input (for mismatch detection)
  result JSONB,                            -- stored result for replay
  error JSONB,                             -- stored error for replay
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL          -- TTL-based expiration
);

CREATE INDEX idx_idempotency_expires ON idempotency_record(expires_at);
```

### Flow:

```
Agent calls: create_invoice({ idempotencyKey: "inv-2026-05-10-order-12345", ... })

1. Check idempotency_record for key "inv-2026-05-10-order-12345"
2. If found and status=completed → return stored result (no re-execution)
3. If found and status=pending → return "request in progress" (prevent duplicate processing)
4. If found and status=failed → re-execute (previous attempt failed)
5. If not found → INSERT with status=pending, execute, UPDATE to completed, store result
```

### Input mismatch detection:

If the same key is used with **different input**, we detect it via `input_hash`:

```json
{
  "error": "IDEMPOTENCY_KEY_MISMATCH",
  "message": "Idempotency key 'inv-2026-05-10-order-12345' was already used with different input. This suggests a bug in the calling agent. Use a new idempotency key for a different operation.",
  "originalInputHash": "sha256:a1b2c3..."
}
```

### TTL policy:

| Tool type | TTL | Rationale |
|-----------|-----|-----------|
| Simple creates (create_party, create_product) | 24 hours | Enough for agent retries |
| Financial operations (post_journal_entry, create_invoice) | 90 days | Financial audit requirement |
| Status transitions | 1 hour | Short-lived, agent should re-query state |
| Compound tools | 7 days | Multi-step operations may be retried over longer periods |

### Key format convention:

```
{tool-prefix}-{date}-{unique-identifier}
```

Examples:
- `inv-2026-05-10-order-12345` (invoice for order 12345)
- `party-create-acme-corp-20260510` (create Acme Corp party)
- `gl-post-2026-05-period-close` (GL period close entry)

## Alternatives Considered

| Alternative | Pros | Cons | Verdict |
|-------------|------|------|---------|
| **No idempotency (hope for the best)** | Simplest implementation | Duplicates in ERP data are catastrophic | ❌ Unacceptable |
| **Application-level dedup (check before write)** | No extra table | Race conditions, TOCTOU issues, not reliable under concurrency | ❌ Not reliable |
| **Database unique constraints only** | Enforced at DB level | Only prevents exact duplicates, doesn't handle different-input-same-intent, no result replay | ❌ Insufficient |
| **Idempotency key with stored results (chosen)** | Reliable, replay-capable, mismatch detection | Extra table, storage overhead, must be cleaned up | ✅ Industry standard pattern |
| **Event sourcing with deterministic replay** | Full replay capability | Massive architecture change, overkill for this purpose | ❌ Too much |

## Consequences

### Positive
- AI agents can safely retry any operation without fear of duplication
- Stored results enable instant replay (no re-execution cost)
- Input mismatch detection catches agent bugs early
- Different TTLs per tool type balance storage cost vs. safety
- Industry-standard pattern (Stripe, AWS, etc. use the same approach)

### Negative
- Every write tool has an extra DB round-trip (check + insert record)
- Storage grows over time — needs a cleanup job for expired records
- TTL management adds complexity (different TTLs per tool type)
- Compound tools must handle partial failure + idempotency (if step 3 of 5 fails, replay must resume, not restart)

### Mitigations
- Clean up expired records via a nightly cron job (`DELETE FROM idempotency_record WHERE expires_at < NOW()`)
- For compound tools, use a checkpoint-based approach: store progress in the idempotency record so replay resumes from the last successful step
- Benchmark the overhead — if the extra DB round-trip is too slow, consider an in-memory Redis cache for hot idempotency keys with PostgreSQL as the persistent store

## References

- [Stripe Idempotency Keys](https://stripe.com/docs/api/idempotent_requests)
- [AWS Idempotency](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/Run_Instance_Idempotency.html)
- AGENTIC_AI_DESIGN.md — Principle 4
