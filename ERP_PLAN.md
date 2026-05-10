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

### Phase 0: Foundation (Weeks 1-3) — *You are here*

**Infrastructure:**
- [ ] Initialize monorepo (Nx)
- [ ] Set up PostgreSQL + pgvector + Prisma
- [ ] Set up MCP Tool Server infrastructure
- [ ] CI/CD pipeline (lint, test, build, migrate)

**Core Schema:**
- [ ] Implement `core-party` schema (PARTY, PERSON, ORGANIZATION, PARTY_TYPE, PARTY_ROLE, CONTACT_MECHANISM)
- [ ] Implement `core-security` (USER linked to PARTY, ROLE, PERMISSION, AGENT restrictions)
- [ ] Implement type-table infrastructure (seed scripts with AI descriptions + examples)
- [ ] Implement multi-tenancy (tenant isolation via ORGANIZATION + row-level security)

**Agentic AI Layer:**
- [ ] Create `entity_descriptor` table and seed for core entities
- [ ] Create `ai_action_log` table and logging middleware
- [ ] Create `confirmation_gate` table and enforcement middleware
- [ ] Implement idempotency key middleware
- [ ] Build discovery tools: `describe_entity`, `get_type_table_values`, `get_valid_transitions`
- [ ] Enhance all TYPE tables with `description`, `ai_prompt_hint`, `example` columns
- [ ] Design agent permission model (inherits user perms + agent restrictions)

**API Scaffold:**
- [ ] NestJS modules, guards, interceptors
- [ ] MCP tool registration framework
- [ ] Tool contract test framework

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
│   │   │   ├── mcp/                  # MCP Tool Server (NEW)
│   │   │   │   ├── tools/            # Tool definitions (per module)
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
│   ├── mcp-tools/                    # MCP tool definitions (NEW)
│   │   ├── src/
│   │   │   ├── schemas/              # JSON Schema for every tool
│   │   │   ├── descriptions/         # Natural language tool descriptions
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
├── ERP_PLAN.md                       # This file
├── nx.json / turbo.json
├── package.json
├── tsconfig.base.json
└── .github/
    └── workflows/
        └── ci.yml
```

---

## 7. Key Design Decisions to Make

| # | Decision | Options | Recommendation |
|---|----------|---------|----------------|
| 1 | **ORM** | TypeORM vs Prisma vs Kysely | **Prisma** — excellent migration tooling, type-safe queries, growing ecosystem |
| 2 | **Monorepo Tool** | Nx vs Turborepo vs Lerna | **Nx** — powerful task graph, affected builds, code generation |
| 3 | **Multi-tenancy Strategy** | Schema-per-tenant vs Row-Level Security vs DB-per-tenant | **Row-Level Security (RLS)** — good balance of isolation & cost |
| 4 | **Event Bus** | BullMQ vs Kafka vs NATS | **BullMQ** initially, migrate to Kafka if needed at scale |
| 5 | **Supertype/Subtype Implementation** | Class Table Inheritance vs Single Table | **Class Table Inheritance** — normalized, performant, Silverstone-aligned |
| 6 | **API Style** | REST-only vs GraphQL-only vs MCP-only vs All | **All three** — MCP for AI agents, REST for writes, GraphQL for reads/reports |
| 7 | **UI Framework** | MUI vs Ant Design vs Chakra vs shadcn/ui | **shadcn/ui** — modern, composable, Tailwind-based |
| 8 | **Auth Provider** | Custom vs Auth0 vs Keycloak | **Keycloak** — open-source, OIDC, integrates with PARTY model |
| 9 | **Tool Protocol** | Custom vs MCP vs OpenAI Functions | **MCP** — open standard, model-agnostic, rich tool definitions |
| 10 | **Agent Runtime** | LangChain vs LlamaIndex vs custom | **LangChain + custom** — orchestration + domain-specific reasoning |
| 11 | **Semantic Search** | Elasticsearch vs pgvector vs Both | **pgvector** — one less system to operate, good enough for ERP-scale |

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

1. **Confirm tech stack** (review Section 7 decisions — now 11 decisions including MCP, agent runtime, semantic search)
2. **Read [AGENTIC_AI_DESIGN.md](./AGENTIC_AI_DESIGN.md) thoroughly** — this is the biggest differentiator
3. **Initialize the monorepo** (Nx + Prisma + NestJS + Next.js + MCP)
4. **Set up MCP Tool Server infrastructure** (the AI-facing interface — this is new)
5. **Design & implement `core-party` schema** with enhanced TYPE tables (AI descriptions + examples)
6. **Build seed data** for type tables WITH AI descriptions and examples
7. **Create `entity_descriptor` entries** for all core entities
8. **Create API scaffold** with auth, multi-tenancy, idempotency, and MCP tools for core-party
9. **Write tool contract tests** — test the AI-facing interface first
10. **Write agent workflow tests** — test end-to-end agent scenarios

---

*"The Data Model Resource Book" gives us the **what** — universal, proven data patterns.
*Agentic AI* gives us the **how** — the system understands itself, guides its operators, and evolves.
**Our job** is to bring them together into the best ERP ever built.*
