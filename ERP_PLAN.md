# BestERP — Master Development Plan

## Leveraging Len Silverstone's "The Data Model Resource Book" (Revised Edition)

---

## 1. Vision & Principles

**Goal:** Build a modular, extensible, standards-based ERP system whose data architecture is grounded in Len Silverstone's universal data models — designed from the ground up for **agentic AI operation**, where AI agents are the primary users of the system.

> 📘 See [AGENTIC_AI_DESIGN.md](./AGENTIC_AI_DESIGN.md) for the full agentic AI architecture and design considerations.

### Core Principles

| # | Principle | Rationale |
|---|-----------|-----------|
| 1 | **Universal Data Models First** | Silverstone's patterns (Party, Product, Order, Invoice, etc.) are battle-tested across industries |
| 2 | **Supertype/Subtype Architecture** | Every major entity uses supertype tables (e.g., PARTY → PERSON/ORGANIZATION) for maximum flexibility |
| 3 | **Type Tables, Not Enums** | All classifications use TYPE tables (e.g., PARTY_TYPE, ORDER_TYPE) so the system is data-driven, not code-driven |
| 4 | **Effective Dating & Status Tracking** | Every critical entity supports from/to dates and status history — essential for audit, HR, and temporal queries |
| 5 | **Modular Bounded Contexts** | Each ERP module maps to one or more of Silverstone's subject areas but ships as an independent bounded context |
| 6 | **Agent-First Tool Interface** | Every operation is exposed as a semantically-named MCP tool with rich descriptions, not just CRUD endpoints |
| 7 | **Multi-Tenant from Day One** | Party-based tenancy; each tenant is an ORGANIZATION with isolated data |
| 8 | **Schema-as-Prompt** | All entity schemas, type tables, and workflows are self-describing so AI agents can discover and reason about them |
| 9 | **Idempotent by Default** | Every write tool accepts an idempotency key — AI agents may retry or get interrupted |
| 10 | **AI-Traceable Audit** | Every action logs who (human), what (agent), why (reasoning), and how (tools called) |

---

## 2. Silverstone Subject Areas → ERP Modules Mapping

The book is organized into chapters by subject area. We map each to a BestERP module:

| Book Subject Area (Ch.) | BestERP Module | Priority | Notes |
|--------------------------|---------------|----------|-------|
| Ch 1-2: Party & Contact Mechanisms | **core-party** | 🔴 P0 | Foundation — people, orgs, roles, addresses, phone, email |
| Ch 3: Product / Goods | **core-product** | 🔴 P0 | Items, categories, features, inventory |
| Ch 4: Order Entry | **mod-sales** | 🔴 P0 | Quotes, orders, order lines, commitments |
| Ch 5: Shipment / Fulfillment | **mod-fulfillment** | 🟡 P1 | Shipments, tracking, delivery |
| Ch 6: Invoice / Billing | **mod-billing** | 🔴 P0 | Invoices, invoice items, terms |
| Ch 7: Accounting (GL) | **mod-accounting** | 🔴 P0 | GL accounts, journal entries, fiscal periods |
| Ch 8: Inventory | **mod-inventory** | 🟡 P1 | Inventory items, balances, transfers, reservations |
| Ch 9: HR / Employment | **mod-hr** | 🟡 P1 | Positions, employment, payroll types |
| Ch 10: Work Effort / Projects | **mod-projects** | 🟢 P2 | Tasks, timesheets, milestones |
| Ch 11: Facility / Asset | **mod-assets** | 🟢 P2 | Fixed assets, depreciation, facilities |
| Ch 12: Manufacturing / BOM | **mod-manufacturing** | 🟢 P2 | BOM, routing, work orders |
| Cross-cutting: Agreements / Contracts | **mod-agreements** | 🟡 P1 | Contracts, terms, SLAs |
| Cross-cutting: Security / Users | **core-security** | 🔴 P0 | Users, roles, permissions (mapped via PARTY) |

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      Users (Human)                               │
│              ┌───────────────┬──────────────┐                    │
│              │   Web UI      │   Chat UI    │                    │
│              └───────┬───────┴──────┬───────┘                    │
│                      │              │                             │
│          ┌───────────▼──────────────▼───────────┐                │
│          │        AI Agent Orchestrator          │                │
│          │  (Intent parsing, planning,           │                │
│          │   tool selection, execution)           │                │
│          └───────────────┬───────────────────────┘                │
│                          │ tool calls                             │
│          ┌───────────────▼───────────────────────┐               │
│          │         MCP Tool Server                │ ◄── PRIMARY  │
│          │  (Semantic tools, validation,          │     INTERFACE│
│          │   confirmation gates, audit)           │               │
│          └───────────────┬───────────────────────┘               │
│                          │                                       │
│          ┌───────────────▼───────────────────────┐               │
│  ┌───────┴──────────┐                             │               │
│  │ REST + GraphQL   │  (secondary interfaces)     │               │
│  └───────┬──────────┘                             │               │
│          ┌▼──────────────┐                         │               │
│          │ Domain         │                         │               │
│          │ Services       │                         │               │
│          │                │                         │               │
│          │ ┌──────────┐ ┌──────────┐ ┌──────────┐  │               │
│          │ │core-party│ │core-prod │ │mod-sales │  │               │
│          │ └──────────┘ └──────────┘ └──────────┘  │               │
│          └────────┬──────┘                         │               │
│                   │                                 │               │
│          ┌────────▼──────────────────────────────┐  │               │
│          │ PostgreSQL + pgvector  │ Redis  │ MinIO│  │               │
│          └────────────────────────────────────────┘  │               │
├─────────────────────────────────────────────────────────────────┤
│                    Infrastructure / DevOps                        │
│         (Docker · K8s · CI/CD · Observability)                  │
└─────────────────────────────────────────────────────────────────┘
```

### Technology Stack (Recommended)

| Layer | Choice | Why |
|-------|--------|-----|
| **Language** | TypeScript (Node.js) | Full-stack type safety, massive ecosystem |
| **Framework** | NestJS | Modular DI, decorators, enterprise patterns |
| **Database** | PostgreSQL + **pgvector** | Best OSS relational DB; vector search for semantic/AI queries |
| **ORM** | Prisma | Type-safe DB access, migrations, excellent tooling |
| **Cache** | Redis | Sessions, rate limiting, materialized views |
| **Queue** | BullMQ (Redis-backed) | Domain events, async jobs |
| **Tool Protocol** | **MCP (Model Context Protocol)** | Standard protocol for exposing tools to AI agents |
| **API** | REST + GraphQL + **MCP Tools** | REST for basic CRUD, GraphQL for reports, MCP for AI agents |
| **Frontend** | React + Next.js + **Chat UI** | SSR, ecosystem, AI chat interface |
| **Auth** | Keycloak (OIDC) | Standards-based, integrates with PARTY model, SSO |
| **Search** | **pgvector** + PostgreSQL FTS | Semantic + traditional search in one engine |
| **File Storage** | MinIO / S3 | Attachments, documents |
| **Docs** | Swagger / OpenAPI 3 | Auto-generated from NestJS decorators |
| **Agent Runtime** | LangChain / custom | AI agent orchestration, tool calling, reasoning |

---

## 4. Universal Data Model Patterns (from Silverstone)

These patterns appear **repeatedly** across modules. We implement them once as reusable building blocks.

### 4.1 Party Model

```
PARTY (supertype)
├── PERSON (subtype)
├── ORGANIZATION (subtype)
├── PARTY_TYPE (e.g., Customer, Supplier, Employee, Tenant)
├── PARTY_ROLE (e.g., Buyer, Seller, Ship-To, Bill-To)
├── PARTY_RELATIONSHIP (e.g., Employed-By, Subsidiary-Of)
└── CONTACT_MECHANISM
    ├── POSTAL_ADDRESS
    ├── TELECOM_NUMBER
    ├── EMAIL_ADDRESS
    └── WEB_ADDRESS
```

### 4.2 Product Model

```
PRODUCT (supertype)
├── GOOD (subtype — physical item)
├── SERVICE (subtype)
├── PRODUCT_TYPE (e.g., Finished Good, Raw Material, Sub-Assembly)
├── PRODUCT_CATEGORY (hierarchical classification)
├── PRODUCT_FEATURE (color, size, weight — extensible)
├── PRODUCT_PRICE (multiple price types, effective dates)
├── SUPPLIER_PRODUCT (vendor-specific SKU, lead time)
└── PRODUCT_ASSOCIATION (cross-sell, substitute, component-of)
```

### 4.3 Order Model

```
ORDER (supertype = Order Header)
├── ORDER_TYPE (Sales, Purchase, Return, Transfer)
├── ORDER_ROLE (Buyer, Seller, Ship-To, Bill-To)
├── ORDER_ITEM (line items)
│   ├── ORDER_ITEM_TYPE
│   ├── ORDER_ITEM_ROLE
│   └── ORDER_ADJUSTMENT (discounts, tax, shipping)
├── ORDER_STATUS (effective-dated status history)
├── ORDER_TERM (payment terms, delivery terms)
└── ORDER_COMMITMENT (inventory reservation, delivery promise)
```

### 4.4 Invoice / Billing Model

```
INVOICE (supertype)
├── INVOICE_TYPE (Sales, Purchase, Credit, Debit)
├── INVOICE_ITEM
│   └── INVOICE_ITEM_TYPE
├── INVOICE_ROLE (Bill-To, Bill-From)
├── INVOICE_STATUS (effective-dated)
├── INVOICE_TERM
└── PAYMENT
    ├── PAYMENT_TYPE
    ├── PAYMENT_APPLICATION (to invoice items)
    └── PAYMENT_STATUS
```

### 4.5 Accounting Model

```
GL_ACCOUNT
├── GL_ACCOUNT_TYPE (Asset, Liability, Equity, Revenue, Expense)
├── GL_ACCOUNT_CATEGORY
├── GL_FISCAL_PERIOD
├── GL_JOURNAL_ENTRY
│   ├── GL_JOURNAL_ENTRY_TYPE
│   └── GL_JOURNAL_ENTRY_LINE (debit/credit)
└── GL_ACCOUNT_HISTORY (running balances)
```

### 4.6 Inventory Model

```
INVENTORY_ITEM
├── INVENTORY_ITEM_TYPE (Serialized, Lot, Bulk)
├── INVENTORY_ITEM_STATUS
├── INVENTORY_ITEM_LOCATION (facility + location)
├── INVENTORY_TRANSFER
├── INVENTORY_RESERVATION
└── INVENTORY_COUNT_VARIANCE (physical count adjustment)
```

### 4.7 Universal Patterns Summary

| Pattern | Used In | Description |
|---------|---------|-------------|
| **Supertype/Subtype** | Party, Product, Order, Invoice | One parent table + child discriminators |
| **Type/Classification Tables** | Every entity | Replace hard-coded enums with TYPE rows |
| **Role Pattern** | Party, Order, Invoice | One entity plays many roles over time |
| **Effective Dating** | Status, Price, Terms | FROM_DATE / THRU_DATE on every versioned row |
| **Status Flow** | Order, Invoice, Inventory | STATUS + STATUS_VALID_CHANGE (state machine) |
| **Adjustment Pattern** | Order, Invoice | Line-level + header-level adjustments |
| **Relationship Pattern** | Party, Product | Directed relationships with type + dates |
| **Contact Mechanism** | Party, Facility, Order | Polymorphic contact info (address, phone, email) |
| **Agreement/Contract** | Cross-cutting | Terms, roles, items — reusable contract model |
| **Geo / Geographic** | Address, Facility, Tax | Country → Region → City hierarchy |

---

## 5. Phased Implementation Plan

### Phase 0: Foundation (Weeks 1-6) — Phase 0a complete, entering Phase 0b

> **Note:** ADRs for key decisions are in `docs/architecture/`. Read them before implementing:
> - ADR-001: MCP as Primary Agent Interface
> - ADR-002: Row-Level Security for Multi-Tenancy
> - ADR-003: Class Table Inheritance for Supertype/Subtype
> - ADR-004: Idempotency Key Pattern for Write Tools

#### Phase 0a: Spike & Validation (Weeks 1-2) ✅ COMPLETE

Validate core assumptions with a minimal prototype before committing to the full stack.

- [x] Set up monorepo scaffold (npm workspaces + TypeScript)
- [x] Set up PostgreSQL + Prisma (basic connection, one migration)
- [x] Implement **one entity end-to-end**: `core-party` (PARTY, PERSON, ORGANIZATION, PARTY_TYPE)
- [x] Implement RLS for multi-tenancy on the party table (ADR-002)
- [x] Implement Class Table Inheritance for PARTY → PERSON/ORGANIZATION (ADR-003)
- [x] Build **one MCP tool**: `create_party` with JSON Schema + description (ADR-001)
- [x] Implement idempotency key handling for `create_party` (ADR-004)
- [x] Implement `ai_action_log` for the one tool
- [x] Write tool contract test for `create_party`
- [x] Write tenant isolation test (tenant A can't see tenant B's data)
- [x] **Spike review:** validate Prisma + RLS, MCP tool ergonomics, idempotency overhead
- [x] Benchmark RLS query overhead (< 15% target) and idempotency extra round-trip (< 10ms target)

**Spike Findings (folded into ADR-002):**
- Superusers ALWAYS bypass RLS — must use non-superuser `besterp_app` role
- RLS policies need `WITH CHECK` clause for INSERT/UPDATE
- `SET LOCAL` only works inside `$transaction` — cannot use middleware pattern
- Pure RLS overhead: ~0%. Transaction wrapping: ~0.8ms/query extra
- MCP stdio transport validated with 3 tools (create_party, list_available_tools, get_type_table_values)

#### Phase 0b: Core Infrastructure (Weeks 2-4)

- [ ] CI/CD pipeline (lint, test, build, migrate)
- [ ] Set up pgvector extension for semantic search
- [ ] Set up Redis for caching + queues (BullMQ)
- [ ] MCP Tool Server infrastructure (middleware pipeline, registration framework)
- [ ] NestJS modules, guards, interceptors, Prisma Client Extension for RLS
- [ ] Docker Compose for local development (PostgreSQL, Redis, MinIO)

#### Phase 0c: Core Schema + Agentic Layer (Weeks 3-5)

- [ ] Complete `core-party` schema (PARTY_ROLE, CONTACT_MECHANISM + all subtypes)
- [ ] Implement `core-security` (USER linked to PARTY, ROLE, PERMISSION, AGENT restrictions)
- [ ] Implement type-table infrastructure with AI-facing columns (`description`, `ai_prompt_hint`, `example`)
- [ ] Seed scripts for all P0 type tables with AI descriptions
- [ ] Implement multi-tenancy (RLS on all tenant-scoped tables + Prisma middleware)
- [ ] Create `entity_descriptor` table and seed for all core entities
- [ ] Create `ai_action_log` table and logging middleware
- [ ] Create `confirmation_gate` table and enforcement middleware
- [ ] Implement idempotency key middleware (generalized for all write tools)
- [ ] Design agent permission model (inherits user perms + agent restrictions)
- [ ] Design agent registry (agent_id, capabilities, version, rate limits)

#### Phase 0d: Discovery Tools + Testing (Weeks 5-6)

- [ ] Build discovery tools: `describe_entity`, `get_type_table_values`, `get_valid_transitions`
- [ ] Build `list_available_tools` discovery tool
- [ ] Tool contract test framework
- [ ] Tool contract tests for all `core-party` tools
- [ ] End-to-end agent workflow test ("create a customer with contacts")
- [ ] Idempotency tests (same key → same result, different input → error)
- [ ] Confirmation gate tests

**Tool-First Development Workflow Established:**
For every entity: define descriptor → define tools → define types → define status machine → implement domain → wire tools → test



### Phase 1: Core Transactions (Weeks 3-8)

- [ ] `core-product` — Products, categories, features, pricing
- [ ] `mod-sales` — Quotes → Orders → Confirmations (full status flow)
- [ ] `mod-billing` — Invoices, adjustments, terms
- [ ] `mod-accounting` — GL accounts, journal entries, fiscal periods
- [ ] Payment integration (record payments, apply to invoices)
- [ ] Relate orders ↔ invoices ↔ payments ↔ GL entries
- [ ] MCP tools for all P0 modules
- [ ] Compound tools (e.g., `create_customer_with_contacts`, `fulfill_and_invoice_order`)
- [ ] Unit + integration + tool contract tests (≥ 85% coverage on core)

### Phase 2: Operations (Weeks 9-14)

- [ ] `mod-inventory` — Items, locations, reservations, transfers
- [ ] `mod-fulfillment` — Shipments, tracking, delivery confirmation
- [ ] `mod-agreements` — Contracts, terms, SLAs
- [ ] Inventory ↔ Sales integration (availability checks, reservations)
- [ ] Fulfillment ↔ Billing integration (ship-and-invoice flow)
- [ ] Reporting framework (basic financials: P&L, Balance Sheet, AR/AP aging)

### Phase 3: People & Projects (Weeks 15-20)

- [ ] `mod-hr` — Positions, employment, org chart (via PARTY_RELATIONSHIP)
- [ ] `mod-projects` — Work efforts, tasks, timesheets, milestones
- [ ] Payroll types & compensation structures
- [ ] Expense management
- [ ] Project costing (link timesheets → GL entries)

### Phase 4: Advanced (Weeks 21-28)

- [ ] `mod-assets` — Fixed assets, depreciation schedules, facility management
- [ ] `mod-manufacturing` — BOM, routing, work orders, production tracking
- [ ] Advanced reporting & dashboards
- [ ] Workflow engine (configurable approval flows via status machines)
- [ ] Multi-currency support
- [ ] Localization framework (i18n, tax rules by region)

### Phase 5: Polish & Scale (Weeks 29+)

- [ ] Performance optimization (query tuning, materialized views, CQRS where needed)
- [ ] Comprehensive admin UI
- [ ] Self-service portal for customers/suppliers
- [ ] Mobile app
- [ ] Third-party integrations (banking, shipping carriers, marketplaces)
- [ ] Load testing, security audit, penetration testing
- [ ] Documentation & training materials

---

## 6. Project Structure (Monorepo)

```
besterp/
├── apps/
│   ├── api/                          # NestJS backend
│   │   ├── src/
│   │   │   ├── modules/
│   │   │   │   ├── core/
│   │   │   │   │   ├── party/        # core-party
│   │   │   │   │   ├── product/      # core-product
│   │   │   │   │   └── security/     # core-security
│   │   │   │   ├── sales/            # mod-sales
│   │   │   │   ├── billing/          # mod-billing
│   │   │   │   ├── accounting/       # mod-accounting
│   │   │   │   ├── inventory/        # mod-inventory
│   │   │   │   ├── fulfillment/      # mod-fulfillment
│   │   │   │   ├── hr/               # mod-hr
│   │   │   │   ├── projects/         # mod-projects
│   │   │   │   ├── agreements/       # mod-agreements
│   │   │   │   ├── assets/           # mod-assets
│   │   │   │   └── manufacturing/    # mod-manufacturing
│   │   │   ├── mcp/                  # MCP Tool Server (imports from packages/mcp-tools)
│   │   │   │   ├── middleware/       # Idempotency, audit, confirmation gates
│   │   │   │   ├── discovery/        # Entity descriptors, type table queries
│   │   │   │   └── server.ts         # MCP server setup
│   │   │   ├── agent/                # AI Agent layer (NEW)
│   │   │   │   ├── orchestrator/     # Agent orchestration
│   │   │   │   ├── reasoning/        # Reasoning chain logging
│   │   │   │   └── permissions/      # Agent permission enforcement
│   │   │   ├── common/
│   │   │   │   ├── entities/         # Base entity classes
│   │   │   │   ├── patterns/         # Supertype/subtype helpers
│   │   │   │   ├── types/            # Shared type/table infra
│   │   │   │   └── effective-dating/ # From/thru date utilities
│   │   │   └── config/
│   │   └── test/
│   ├── web/                          # Next.js frontend
│   ├── admin/                        # Admin dashboard
│   └── chat/                         # AI Chat UI (NEW)
├── packages/
│   ├── database/                     # Prisma schemas & migrations
│   │   ├── src/
│   │   │   ├── entities/
│   │   │   ├── migrations/
│   │   │   ├── seeds/
│   │   │   │   ├── party-types.seed.ts
│   │   │   │   ├── order-types.seed.ts
│   │   │   │   ├── product-types.seed.ts
│   │   │   │   ├── gl-account-types.seed.ts
│   │   │   │   └── entity-descriptors.seed.ts  # AI-facing descriptions
│   │   │   └── ai-schema/            # AI action log, confirmation gates, descriptors
│   ├── shared/                       # Shared types, DTOs, tool schemas
│   ├── mcp-tools/                    # MCP tool definitions (CANONICAL SOURCE)
│   │   ├── src/
│   │   │   ├── schemas/              # JSON Schema for every tool
│   │   │   ├── descriptions/         # Natural language tool descriptions
│   │   │   ├── compound/             # Compound tool orchestrations + saga definitions
│   │   │   ├── discovery/            # Discovery tool definitions
│   │   │   └── registry.ts           # Tool registry
│   ├── event-bus/                    # Domain event infrastructure
│   └── test-utils/                   # Test factories, fixtures, agent test helpers
├── docs/
│   ├── data-models/                  # ERD diagrams per module
│   ├── api/                          # OpenAPI specs
│   ├── tools/                        # MCP tool documentation (NEW)
│   ├── ai-agent-guides/              # How AI agents should use the system (NEW)
│   └── architecture/                 # ADRs, diagrams
├── docker/
│   ├── docker-compose.yml
│   ├── Dockerfile.api
│   └── Dockerfile.web
├── scripts/
│   ├── setup.sh
│   ├── seed.sh
│   └── migrate.sh
├── package.json
├── tsconfig.base.json
└── .github/
    └── workflows/
        └── ci.yml
```

---

## 7. Key Design Decisions

All decisions recorded as Architecture Decision Records (ADRs) in `docs/architecture/`.

| # | Decision | Resolution | ADR |
|---|----------|------------|-----|
| 1 | **ORM** | **Prisma** — excellent migration tooling, type-safe queries | — |
| 2 | **Monorepo Tool** | **npm workspaces** — simpler than Nx, sufficient for our module count; migrate to Nx if task-graph caching becomes necessary | — |
| 3 | **Multi-Tenancy Strategy** | **Row-Level Security (RLS)** | [ADR-002](./docs/architecture/adr-002-rls-multi-tenancy.md) |
| 4 | **Event Bus** | **BullMQ** initially, migrate to Kafka if needed at scale | — |
| 5 | **Supertype/Subtype Implementation** | **Class Table Inheritance** | [ADR-003](./docs/architecture/adr-003-class-table-inheritance.md) |
| 6 | **API Style** | **All three** — MCP for AI agents, REST for writes, GraphQL for reads/reports | — |
| 7 | **UI Framework** | **shadcn/ui** — modern, composable, Tailwind-based | — |
| 8 | **Auth Provider** | **Keycloak** — open-source, OIDC, integrates with PARTY model | — |
| 9 | **Tool Protocol** | **MCP (Model Context Protocol)** | [ADR-001](./docs/architecture/adr-001-mcp-tool-protocol.md) |
| 10 | **Agent Runtime** | **LangChain + custom** — orchestration + domain-specific reasoning | — |
| 11 | **Semantic Search** | **pgvector** — one less system to operate | — |
| 12 | **Idempotency** | **Idempotency key with stored results** | [ADR-004](./docs/architecture/adr-004-idempotency-key-pattern.md) |

---

## 8. Success Metrics

| Metric | Target |
|--------|--------|
| Test coverage (core modules) | ≥ 85% |
| Tool contract coverage | 100% of tools have contract tests |
| API response time (p95) | < 200ms |
| Tool response time (p95) | < 300ms |
| Migration reliability | Zero data loss |
| Type table coverage | 100% of classifications data-driven with AI descriptions |
| Effective dating coverage | All status/price/role entities |
| Module independence | Each module deployable independently |
| Agent action audit | 100% of AI actions logged with reasoning |
| Idempotency | 100% of write tools support idempotency keys |
| Discovery completeness | All entities have descriptors, all types have AI descriptions |

---

## 9. Next Steps

1. **Read the ADRs** in `docs/architecture/` — understand the why behind each decision
2. **Read [AGENTIC_AI_DESIGN.md](./AGENTIC_AI_DESIGN.md) thoroughly** — this is the biggest differentiator
3. **Execute Phase 0a spike** — validate Prisma + RLS + MCP with one entity
4. **Review spike results** — confirm or adjust tech stack before proceeding
5. **Proceed with Phase 0b–0d** — infrastructure, schema, discovery tools, testing
6. **Define tool contracts** for Phase 1 modules before writing domain code

---

## 10. Cross-Cutting Concerns

### 10.1 Observability

With AI agents making autonomous tool calls, observability is critical.

| Concern | Solution |
|---------|----------|
| Distributed tracing | OpenTelemetry integration — trace every tool call from agent → MCP → domain → DB |
| Structured logging | JSON logs with correlation IDs (conversation_id, agent_id, tenant_id) |
| Metrics | Tool call latency, error rates, confirmation gate escalation rates, token usage |
| AI-specific metrics | Agent retry rates, hallucination guard triggers, discovery tool usage frequency |
| Dashboards | Grafana dashboards for tool health, agent behavior, system performance |
| Alerting | Alert on: tool error rate > 5%, agent retry rate > 20%, confirmation gate timeout |

### 10.2 Data Privacy & Classification

ERP systems hold PII, financial data, and employment records.

| Data Class | Examples | Handling |
|------------|----------|----------|
| **PII** | Names, emails, phone, addresses | Encryption at rest, access logging, GDPR right-to-delete support |
| **Financial** | Invoice amounts, GL balances, payment info | Encryption at rest, SOX-compliant audit trail, field-level access control |
| **Employment** | Salary, performance reviews, health data | Strictest access control, HR-role-only visibility, retention policies |
| **System** | AI action logs, agent reasoning | Tenant-scoped, immutable, configurable retention |

**Implementation:**
- Column-level encryption for PII fields (via application-level encryption in Prisma middleware)
- `data_classification` column on sensitive tables for policy enforcement
- GDPR endpoints: `export_party_data`, `delete_party_data` (with cascading rules)
- Field-level access control in the MCP tool layer (mask PII for non-privileged agents)

### 10.3 API Versioning

Tool schemas will evolve. Breaking changes must be managed.

| Strategy | Details |
|----------|--------|
| **Tool versioning** | Tools are versioned: `create_order` → `create_order_v2` (old version deprecated, not removed) |
| **Deprecation window** | Minimum 6 months of parallel operation before removing a deprecated tool |
| **Schema evolution** | New optional fields are always backward-compatible. Required field changes = new tool version |
| **Agent notification** | Deprecated tools return a `deprecation_warning` field with migration guidance |
| **Version registry** | `list_available_tools` shows current + deprecated tools with deprecation dates |

### 10.4 Event Model

We use **traditional CRUD with event publishing** (not full event sourcing).

- Every domain write publishes a domain event to BullMQ
- Events are used for: cross-module coordination, real-time UI updates, AI agent notifications
- Event schema is versioned and backward-compatible
- `ai_action_log` captures the AI-specific audit trail (separate from domain events)
- Future option: replay events for debugging AI agent sessions, but not for state reconstruction

### 10.5 Concurrency Control

| Concern | Solution |
|---------|----------|
| Optimistic locking | Every mutable entity has a `version` column incremented on update |
| Conflict detection | If `version` mismatches, return `CONCURRENT_MODIFICATION` error with current state |
| AI agent conflicts | AI agents get a rich error: "Order was modified by another agent. Current status: X. Re-query and retry." |
| Migration rollback | All Prisma migrations use explicit `up` and `down` scripts; rollback tested in CI |
| Migration locking | Migrations run with advisory locks to prevent concurrent migration execution |

### 10.6 Multi-Currency Considerations

> **Note:** Full multi-currency is deferred to Phase 4, but the schema must be ready.

- All monetary columns use `DECIMAL(19,4)` (not FLOAT) from Day 1
- Every monetary amount includes a `currency_id` column (defaulting to tenant's base currency)
- GL account structure supports multi-currency revaluation entries
- Exchange rate table seeded in Phase 0 (even if not used until Phase 4)

---

*"The Data Model Resource Book" gives us the **what** — universal, proven data patterns.
*Agentic AI* gives us the **how** — the system understands itself, guides its operators, and evolves.
**Our job** is to bring them together into the best ERP ever built.*
