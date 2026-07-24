// Prisma Service — NestJS-compatible PrismaClient wrapper with RLS support.
//
// Provides:
// - The base admin PrismaClient (for migrations, cross-tenant operations)
// - `createTenantClient(tenantId)` — returns an RLS-scoped client for a tenant
//
// IMPORTANT: The base client connects as the admin role (DATABASE_ADMIN_URL)
// for write operations that bypass RLS. The tenant-scoped client connects
// as the app role (DATABASE_URL) where RLS is enforced.

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { createTenantClient, validateTenantIdEnhanced, CreateTenantClientOptions, TenantScopedClient } from "@besterp/database";
import { MAX_TENANT_CACHE_SIZE, sanitizeForLogOutput } from "@besterp/shared";

// Cache configuration constants — exported for testing and override via env
export const DEFAULT_MAX_METHOD_CACHE_SIZE = 1000;
export const DEFAULT_MAX_DELEGATE_CACHE_SIZE = 50;

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  private readonly _appClient: PrismaClient;
  private _destroyed = false;
  /** Cache of tenant-scoped Proxy clients to avoid GC pressure from repeated creation. */
  private readonly tenantClientCache = new Map<string, WeakRef<TenantScopedClient>>();
  // FinalizationRegistry evicts cache entries when GC collects the Proxy.
  // Note: we do NOT try to $disconnect the tenant client because the Proxy
  // blocks $disconnect (tenant clients share the underlying _appClient connection).
  // Unregister tokens are stored separately so we can always unregister without
  // needing to deref the WeakRef (which may already be GC'd).
  private readonly cacheRegistry = new FinalizationRegistry<string>((tenantId: string) => {
    // Guard: the registry callback can fire after onModuleDestroy clears the maps.
    // The Map.delete() on a non-existent key is a no-op, so this is safe, but
    // we skip the token cleanup if the service is already destroyed.
    if (this._destroyed) return;
    // Race condition guard: between the old client being GC'd and this callback
    // firing, a NEW client for the same tenantId may have been created and cached.
    // Only delete the cache entry if the WeakRef for this tenantId is actually
    // dead — if a new client exists, its WeakRef would still be alive.
    // The _destroyed guard (checked above) prevents this from operating on
    // cleared maps during shutdown.
    const ref = this.tenantClientCache.get(tenantId);
    if (ref && ref.deref()) return;
    this.tenantClientCache.delete(tenantId);
    this.unregisterTokens.delete(tenantId);
    this.lastAccessed.delete(tenantId);
  });
  private readonly unregisterTokens = new Map<string, object>();
  /** Access timestamps for LRU eviction — updated on each cache hit. */
  private readonly lastAccessed = new Map<string, number>();

  /** Cache hit/miss counters for observability. */
  private cacheHits = 0;
  private cacheMisses = 0;

  // Cache sizes — configurable via env vars for tuning in production
  private readonly maxMethodCacheSize: number;
  private readonly maxDelegateCacheSize: number;

  constructor() {
    // Base client uses admin URL for migrations, seed, cross-tenant ops.
    // Do NOT fall back to DATABASE_URL — the admin client must bypass RLS.
    // If DATABASE_ADMIN_URL is missing, audit logs and idempotency writes
    // would silently fail with RLS violations when using the app role.
    const adminUrl = process.env.DATABASE_ADMIN_URL?.trim();
    if (!adminUrl && process.env.NODE_ENV !== "development") {
      throw new Error(
        "DATABASE_ADMIN_URL is not set. The admin client requires a superuser " +
        "connection string to bypass RLS for audit/idempotency operations."
      );
    }
    super({
      datasourceUrl: adminUrl ?? process.env.DATABASE_URL,
      log: [
        { emit: "stdout", level: "warn" },
        { emit: "stdout", level: "error" },
      ],
    });

    // App client uses the non-superuser URL for RLS-enforced operations
    if (!process.env.DATABASE_URL) {
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          "DATABASE_URL environment variable is not set. " +
          "The app client requires DATABASE_URL to connect as the RLS-enforced role."
        );
      }
      this.logger.warn(
        "DATABASE_URL is not set — database operations will fail. " +
        "Set DATABASE_URL before running the API."
      );
    }
    if (!process.env.DATABASE_ADMIN_URL) {
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          "DATABASE_ADMIN_URL environment variable is not set. " +
          "The admin client requires DATABASE_ADMIN_URL to connect as a superuser " +
          "role for cross-tenant audit/idempotency operations."
        );
      }
      this.logger.warn(
        "DATABASE_ADMIN_URL is not set — admin operations will fail. " +
        "Set DATABASE_ADMIN_URL before running the API."
      );
    }
    this._appClient = new PrismaClient({
      datasourceUrl: process.env.DATABASE_URL, // must be the besterp_app role
      log: [
        { emit: "stdout", level: "warn" },
        { emit: "stdout", level: "error" },
      ],
    });

    // Read cache sizes from env with defaults — clamp to [1, 100_000] to
    // prevent negative values (invalid LRU caches) and absurdly large values
    // (memory exhaustion). 100K entries is far above any realistic workload.
    this.maxMethodCacheSize = Math.min(100_000, Math.max(1, Number(process.env.PRISMA_MAX_METHOD_CACHE_SIZE) || DEFAULT_MAX_METHOD_CACHE_SIZE));
    this.maxDelegateCacheSize = Math.min(100_000, Math.max(1, Number(process.env.PRISMA_MAX_DELEGATE_CACHE_SIZE) || DEFAULT_MAX_DELEGATE_CACHE_SIZE));
  }

  async onModuleInit() {
    if (!process.env.DATABASE_ADMIN_URL && process.env.NODE_ENV !== "production") {
      this.logger.warn(
        "DATABASE_ADMIN_URL is not set — admin client falls back to DATABASE_URL. " +
        "Audit logs and idempotency records (which use the admin client to bypass RLS) " +
        "will be silently rejected by RLS policies. Set DATABASE_ADMIN_URL to a superuser " +
        "connection string to fix."
      );
    }
    try {
      const connectResults = await Promise.allSettled([
        this.$connect(),
        this._appClient.$connect(),
      ]);
      for (const result of connectResults) {
        if (result.status === "rejected") {
          // Disconnect any successfully connected clients before re-throwing
          await Promise.allSettled([this.$disconnect(), this._appClient.$disconnect()]);
          throw result.reason;
        }
      }
      this.logger.log("Database connections established (admin + app)");
      await this.verifyAppClientRole();
      await this.verifyRlsEnabled();
    } catch (error: unknown) {
      // Sanitize before logging: Prisma/driver connection errors frequently
      // embed the datasource URL (credentials + hostname) in their message
      // and stack. main.ts's shutdown paths and the global error handler both
      // scrub these via sanitizeForLogOutput — do the same here so the admin
      // and app client connection failures don't leak secrets to operator logs.
      this.logger.error(
        `Failed to connect to database: ${sanitizeForLogOutput(error instanceof Error ? error.message : String(error))}`,
        error instanceof Error && error.stack ? sanitizeForLogOutput(error.stack) : undefined
      );
      throw error;
    }
  }

  async onModuleDestroy() {
    // Mark as destroyed to reject new tenant client requests and prevent
    // FinalizationRegistry callbacks from operating on cleared maps.
    this._destroyed = true;

    // Clear tenant client cache and unregister from FinalizationRegistry
    // to prevent phantom callbacks after the service is destroyed.
    for (const [, token] of this.unregisterTokens) {
      this.cacheRegistry.unregister(token);
    }
    this.tenantClientCache.clear();
    this.unregisterTokens.clear();
    this.lastAccessed.clear();

    const disconnectResults = await Promise.allSettled([
      this.$disconnect(),
      this._appClient.$disconnect(),
    ]);
    const labels: ReadonlyArray<string> = ["admin", "app"];
    for (let i = 0; i < disconnectResults.length; i++) {
      const result = disconnectResults[i]!;
      if (result.status === "rejected") {
        // Sanitize: a disconnect rejection can carry a driver error whose
        // message includes the datasource URL. `${reason}` stringifies an
        // Error as `name: message`, so the URL would reach the log verbatim
        // without this scrub.
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        this.logger.error(`Error disconnecting ${labels[i]} client: ${sanitizeForLogOutput(reason)}`);
      }
    }
  }

  /**
   * Verify the app client connects as a non-superuser role.
   * PostgreSQL superusers bypass all RLS policies, which would silently
   * disable tenant isolation. This catches a common misconfiguration where
   * DATABASE_URL is set to the admin/superuser connection string.
   */
  private async verifyAppClientRole(): Promise<void> {
    try {
      const [roleResult] = await this._appClient.$queryRaw<[{ role: string }]>`SELECT current_user AS role`;
      const role = roleResult.role;
      // Detect superuser privilege directly rather than by role name. A role
      // can be granted SUPERUSER (or renamed) independently of its name, and
      // superusers BYPASS all RLS policies — silently disabling tenant
      // isolation for every tenant-scoped query. Querying pg_roles catches the
      // privilege regardless of how the role is named.
      const [privResult] = await this._appClient.$queryRaw<[{ rolsuper: boolean; rolbypassrls: boolean }]>`
        SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
      `;
      // Fail closed: if pg_roles returned no rows (transient outage, schema
      // drift, or the role was dropped mid-query), we cannot verify the role
      // is not a superuser. Refuse to boot rather than assuming non-superuser.
      if (!privResult) {
        const msg = `Could not determine database role privileges — pg_roles returned no rows for current_user. Cannot verify RLS enforcement.`;
        this.logger.error(msg);
        throw new Error(msg);
      }
      // rolbypassrls (BYPASSRLS) is the authoritative privilege: roles with it
      // skip row-level-security policies entirely, so tenant isolation is
      // silently disabled for every tenant-scoped query. rolsuper also implies
      // BYPASSRLS, so checking both is belt-and-braces.
      const isSuperuser =
        privResult.rolsuper === true || privResult.rolbypassrls === true;
      if (isSuperuser) {
        // PostgreSQL superusers BYPASS all RLS policies, so tenant isolation
        // is silently disabled for every tenant-scoped query when the app
        // client connects as one. This is a hard security failure regardless of
        // environment — start refusing immediately rather than logging a
        // warning that is easy to miss.
        const msg =
          `App client connected as superuser role '${role}' — RLS is BYPASSED and ` +
          `tenant isolation is disabled. Set DATABASE_URL to the besterp_app ` +
          `role connection string.`;
        this.logger.error(msg);
        throw new Error(msg);
      }
      this.logger.debug(`App client connected as role '${role}' (RLS enforced)`);
    } catch (roleErr) {
      if (roleErr instanceof Error && roleErr.message.includes("RLS is BYPASSED")) {
        throw roleErr;
      }
      // The verification query itself failed (permission error on pg_catalog,
      // transient outage, schema drift, …). We must FAIL CLOSED: an
      // unverifiable role means we cannot prove RLS is enforced, and booting
      // silently with a possibly-superuser client silently disables tenant
      // isolation. Refuse to start instead of warn-and-continue.
      const msg = `Could not verify app client database role — refusing to boot (tenant isolation unverified): ${
        sanitizeForLogOutput(roleErr instanceof Error ? roleErr.message : String(roleErr))
      }`;
      this.logger.error(msg);
      throw new Error(msg, { cause: roleErr });
    }
  }

  /**
   * Verify that Row-Level Security is actually enabled on the tenant-scoped
   * tables at boot time. RLS enable + policies live in the standalone
   * `rls-setup.sql` script, which `prisma migrate deploy` does NOT execute.
   * If a deployment forgets to apply it (or recreates the DB from migrations),
   * the tables exist with NO RLS — every tenant-scoped query then returns all
   * tenants' rows with no error: a silent, total cross-tenant data exposure.
   *
   * Refuse to boot if RLS is missing on any of the core tenant tables so the
   * gap is caught in CI / on startup rather than in a security incident.
   */
  private async verifyRlsEnabled(): Promise<void> {
    // The exact set of tables that rls-setup.sql enables RLS + FORCE on.
    // Keep this in sync with rls-setup.sql. Unquoted Postgres identifiers are
    // stored lowercased in pg_class.relname, so the list must be lowercase to
    // match. Previously this list contained "party_relationship" and
    // "audit_log", which do not exist as tables (the real ones are
    // "party_role" and "ai_action_log") — so the check could pass vacuously and
    // give false assurance of tenant isolation at boot.
    const tenantTables = [
      "party",
      "contact_mechanism",
      "party_contact_mechanism",
      "party_role",
      "ai_action_log",
      "idempotency_record",
      "person",
      "organization",
      "postal_address",
      "telecom_number",
      "email_address",
    ];
    try {
      // Query ALL force-RLS tables in `public` (do NOT pre-filter by
      // `= ANY(tenantTables)`). A pre-filter would make the "unexpected extra
      // table" check unreachable: rows could only ever come from the enumerated
      // list, so a new tenant table added to rls-setup.sql (and applied) but
      // omitted here would simply never be inspected and the boot check would
      // pass vacuously — the exact gap round 44 #6 meant to close. By querying
      // everything, we can diff the actual force-RLS set against the
      // authoritative enumeration and refuse to boot on either side of the diff.
      const rows = await this._appClient.$queryRaw<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
      `;
      const found = new Set(rows.map((r) => r.relname));
      // A table missing entirely from pg_class is a coverage gap: rls-setup.sql
      // enabled RLS on it but the table isn't present (or was renamed), so
      // tenant isolation for that data cannot be verified. Refuse to boot
      // rather than silently assuming it's fine.
      const notFound = tenantTables.filter((t) => !found.has(t));
      // Only tenant-scoped tables (those in tenantTables) are expected to have
      // RLS + FORCE applied. Global reference tables (party_type, role_type,
      // contact_mechanism_type, …) are intentionally NOT RLS-enforced — they are
      // shared vocabulary read via the admin client. Filtering `missing` over
      // the FULL set of public tables would wrongly flag those global tables and
      // cause a false "RLS NOT enabled" boot failure on every deployment.
      const missing = rows.filter(
        (r) => tenantTables.includes(r.relname) && (!r.relrowsecurity || !r.relforcerowsecurity),
      );
      // A force-RLS table in the database that is NOT in tenantTables means a
      // new tenant table was added to rls-setup.sql (and applied) but this
      // authoritative list was not updated — its tenant isolation goes
      // unverified. Refuse to boot so the gap is caught rather than silently
      // accepted. Global (non-tenant) tables never have FORCE RLS applied, so
      // this only fires on genuinely tenant-scoped tables.
      const forceRlsNames = new Set(rows.filter((r) => r.relforcerowsecurity).map((r) => r.relname));
      const unexpected = new Set([...forceRlsNames].filter((n) => !tenantTables.includes(n)));
      if (notFound.length > 0 || missing.length > 0 || unexpected.size > 0) {
        const names = [...missing.map((r) => r.relname), ...notFound].join(", ");
        const msg =
          `Row-Level Security is NOT fully enabled (or the table is missing) on tenant tables: ${names}. ` +
          (unexpected.size > 0
            ? `The database reports force-RLS on ${[...unexpected].join(", ")} which are NOT in the verification list of ${tenantTables.length} tables — ` +
              `a new tenant table was likely added to rls-setup.sql without updating the verification list. `
            : "") +
          `Tenant isolation is disabled — apply rls-setup.sql (ENABLE/FORCE ` +
          `ROW LEVEL SECURITY + policies) before starting the service.`;
        this.logger.error(msg);
        throw new Error(msg);
      }
      this.logger.debug("RLS verified enabled (and forced) on tenant tables");
    } catch (rlsErr) {
      if (rlsErr instanceof Error && rlsErr.message.includes("Row-Level Security is NOT fully enabled")) {
        throw rlsErr;
      }
      // The verification query itself failed. Fail closed: an unverifiable RLS
      // state means we cannot prove tenant isolation is active, and booting
      // silently means a forgotten rls-setup.sql apply would expose every
      // tenant's rows with no error. Refuse to start instead of warn-and-continue.
      const msg = `Could not verify RLS enablement — refusing to boot (tenant isolation unverified): ${
        sanitizeForLogOutput(rlsErr instanceof Error ? rlsErr.message : String(rlsErr))
      }`;
      this.logger.error(msg);
      throw new Error(msg, { cause: rlsErr });
    }
  }

  /**
   * Get the admin PrismaClient (bypasses RLS).
   * Use ONLY for: migrations, seed, audit log writes, cross-tenant admin ops.
   */
  get admin(): PrismaClient {
    return this;
  }

  /**
   * Get the app PrismaClient (RLS-enforced path).
   * Use for health checks and other runtime connectivity verification.
   */
  get appClient(): PrismaClient {
    return this._appClient;
  }

  /**
   * Create an RLS-scoped PrismaClient for a specific tenant.
   *
   * All operations on the returned client are wrapped in a transaction
   * that calls `set_tenant_context()` before each query. RLS policies
   * enforce tenant isolation at the database level.
   *
   * Tenant clients are cached via WeakRef to avoid creating a new Proxy
   * on every call. Entries are automatically evicted when GC collects them.
   *
   * @param tenantId - The tenant to scope queries to
   * @returns A Proxy-wrapped PrismaClient with automatic RLS scoping
   */
  tenantScoped(tenantId: string): TenantScopedClient {
    if (this._destroyed) {
      throw new Error(
        "PrismaService is destroyed — cannot create tenant-scoped client. " +
        "This usually means the application is shutting down."
      );
    }

    const normalizedTenantId = validateTenantIdEnhanced(tenantId);

    const cached = this.tenantClientCache.get(normalizedTenantId)?.deref();
    if (cached) {
      this.cacheHits++;
      this.lastAccessed.set(normalizedTenantId, Date.now());
      return cached;
    }

    this.cacheMisses++;

    if (this.tenantClientCache.size >= MAX_TENANT_CACHE_SIZE) {
      this.evictTenantClient();
    }

    const options: CreateTenantClientOptions = {
      maxMethodCacheSize: this.maxMethodCacheSize,
      maxDelegateCacheSize: this.maxDelegateCacheSize,
    };
    const client = createTenantClient(this._appClient, normalizedTenantId, options);
    const token = {};
    this.tenantClientCache.set(normalizedTenantId, new WeakRef(client));
    this.unregisterTokens.set(normalizedTenantId, token);
    this.cacheRegistry.register(client, normalizedTenantId, token);
    this.lastAccessed.set(normalizedTenantId, Date.now());
    return client;
  }

  /**
   * Get cache statistics for observability.
   * @returns Object with hits, misses, hit rate, and current cache size
   */
  getTenantCacheStats(): {
    hits: number;
    misses: number;
    hitRate: number;
    size: number;
    maxSize: number;
  } {
    const total = this.cacheHits + this.cacheMisses;
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      hitRate: total > 0 ? this.cacheHits / total : 0,
      size: this.tenantClientCache.size,
      maxSize: MAX_TENANT_CACHE_SIZE,
    };
  }

  /**
   * Evict a tenant client from the cache when at capacity.
   * Priority: 1) Stale entries (GC'd), 2) Least recently used live entry.
   */
  private evictTenantClient(): void {
    // First pass: collect stale entries and find LRU among live entries
    const staleKeys: string[] = [];
    let lruKey: string | null = null;
    let lruTime = Infinity;

    for (const [key, ref] of this.tenantClientCache) {
      if (!ref.deref()) {
        staleKeys.push(key);
      } else {
        const ts = this.lastAccessed.get(key) ?? 0;
        if (ts < lruTime) {
          lruTime = ts;
          lruKey = key;
        }
      }
    }

    // Evict all stale entries first — remove from ALL tracking maps so dead
    // WeakRef entries and their timestamps don't accumulate indefinitely.
    for (const key of staleKeys) {
      this.removeTenantClient(key);
    }

    // After evicting stale entries, check if we're still at capacity.
    // WeakRef targets may not be GC'd yet, so staleKeys could be empty
    // even though the cache is logically full. Evict LRU if still at capacity.
    if (this.tenantClientCache.size >= MAX_TENANT_CACHE_SIZE && lruKey) {
      this.logger.debug(
        `Tenant client cache full (${MAX_TENANT_CACHE_SIZE}). Evicting LRU entry: '${lruKey}'.`
      );
      this.removeTenantClient(lruKey);
    }
  }

  /**
   * Force cleanup of the tenant client cache.
   * Useful for testing or manual cache clearing.
   */
  clearTenantCache(): void {
    for (const [, token] of this.unregisterTokens) {
      this.cacheRegistry.unregister(token);
    }
    this.tenantClientCache.clear();
    this.unregisterTokens.clear();
    this.lastAccessed.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }

  /** Remove a tenant client and its associated tracking data. */
  private removeTenantClient(tenantId: string): void {
    const token = this.unregisterTokens.get(tenantId);
    if (token) {
      this.cacheRegistry.unregister(token);
      this.unregisterTokens.delete(tenantId);
    }
    this.tenantClientCache.delete(tenantId);
    this.lastAccessed.delete(tenantId);
  }
}
