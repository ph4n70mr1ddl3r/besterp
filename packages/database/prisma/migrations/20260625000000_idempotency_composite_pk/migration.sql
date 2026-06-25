-- Tenant-scoped idempotency keys.
--
-- The idempotency_record primary key previously was (idempotency_key) alone,
-- making keys globally unique across tenants. The application, however, treats
-- idempotency keys as tenant-scoped: every read, create, and update filters by
-- { idempotencyKey, tenantId }. With a global PK, a second tenant that reuses a
-- key another tenant already used (common — clients emit sequential or
-- hash-derived keys) hits a PK violation on insert, which the middleware
-- surfaces as a misleading IDEMPOTENCY_CONTENTION error instead of succeeding.
--
-- This migration aligns the DB constraint with the tenant-scoped intent by
-- making the primary key composite: (idempotency_key, tenant_id). The data is
-- safe to convert: because keys were globally unique, every existing
-- (idempotency_key, tenant_id) pair is already unique.

ALTER TABLE "idempotency_record" DROP CONSTRAINT "idempotency_record_pkey";

ALTER TABLE "idempotency_record" ADD CONSTRAINT "idempotency_record_pkey"
  PRIMARY KEY ("idempotency_key", "tenant_id");
