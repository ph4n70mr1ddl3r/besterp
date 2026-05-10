# BestERP — Agentic AI Design Considerations

## How AI-First ERP Development Changes Everything

---

## 1. The Core Shift: From Human-UI-First to Agent-First

Traditional ERP design optimizes for **human eyes and hands** — forms, grids, wizards, validation dialogs.
Agentic AI-first ERP optimizes for **machine reasoning and tool-calling** — semantic clarity, composability, idempotency, and recoverable errors.

The UI doesn't go away — it becomes a **secondary consumer** of the same agent-facing interfaces.

```
┌──────────────────────────────────────────────────────┐
│                   Users (Human)                       │
│              ┌───────────────┐                        │
│              │   Web UI /    │                        │
│              │   Chat UI     │                        │
│              └──────┬────────┘                        │
│                     │ uses                            │
│              ┌──────▼────────┐                        │
│              │  AI Agents    │  ◄── The primary user  │
│              │  (Orchestrator│                        │
│              │   + Workers)  │                        │
│              └──────┬────────┘                        │
│                     │ calls                           │
│              ┌──────▼────────┐                        │
│              │  Tool Layer   │  ◄── The primary API   │
│              │  (Semantic    │                        │
│              │   Functions)  │                        │
│              └──────┬────────┘                        │
│                     │                                 │
│              ┌──────▼────────┐                        │
│              │  Domain       │                        │
│              │  Services     │                        │
│              └──────┬────────┘                        │
│                     │                                 │
│              ┌──────▼────────┐                        │
│              │  Database     │                        │
│              └───────────────┘                        │
└──────────────────────────────────────────────────────┘
```

---

## 2. Design Principles for Agentic AI ERP

### Principle 1: Tools, Not Endpoints

**Traditional:** `POST /api/orders` with a big JSON body
**Agentic:** `create_sales_order({ customerId, lineItems, shipTo })`

Each tool is:
- **Semantically named** — the name itself tells the AI what it does
- **Single-purpose** — one intent per tool (not a god endpoint)
- **Richly described** — JSON Schema + natural language description the AI reads
- **Returns actionable context** — including what the AI can do next

**Impact on Silverstone:** Every supertype/subtype operation becomes a named tool:
- `create_party` (not `POST /parties`)
- `add_party_role` (not `PATCH /parties/:id/roles`)
- `classify_product` (not `PUT /products/:id/type`)
- `post_journal_entry` (not `POST /gl/journal-entries`)

### Principle 2: Type Tables Are AI Vocabulary

Silverstone's TYPE tables (PARTY_TYPE, ORDER_TYPE, PRODUCT_TYPE, etc.) are already data-driven classifications. For AI, they become **the system's vocabulary**.

**Enhancement:** Every TYPE row needs:
```sql
ALTER TABLE party_type ADD COLUMN description TEXT;
ALTER TABLE party_type ADD COLUMN ai_instructions TEXT;
ALTER TABLE party_type ADD COLUMN valid_role_types UUID[];  -- constraints AI can query
ALTER TABLE party_type ADD COLUMN example JSONB;            -- example entity of this type
```

This means the AI can:
1. Query available types before acting
2. Read descriptions to pick the right classification
3. Understand constraints without trial-and-error
4. Self-correct when it picks the wrong type

### Principle 3: Workflow State Machines Must Be Queryable

AI agents need to **discover** what actions are valid — not hard-code them.

**Traditional:** Frontend knows the order status flow from code.
**Agentic:** AI calls `get_valid_transitions({ entity: 'order', currentStatus: 'confirmed' })` and gets back:
```json
{
  "transitions": [
    { "to": "in_progress", "requires": ["assigned_to"], "tool": "start_order_processing" },
    { "to": "cancelled", "requires": ["cancellation_reason"], "tool": "cancel_order" }
  ]
}
```

**Impact on Silverstone:** The STATUS_VALID_CHANGE table (from the book) becomes a **first-class AI-facing tool**. Every entity with status needs this.

### Principle 4: Operations Must Be Idempotent

AI agents may retry, get interrupted, or call the same operation twice. Every write tool must support **idempotency keys**.

```
create_invoice({
  idempotencyKey: "inv-2026-05-10-order-12345",
  orderId: "12345",
  ...
})
```

If the same key is used again, return the existing result — no duplicate invoices.

### Principle 5: Rich Error Messages Are AI Prompts

**Traditional:** `{ error: "FOREIGN_KEY_VIOLATION" }`
**Agentic:**
```json
{
  "error": "INVALID_PARTY_ROLE",
  "message": "Party 'John Smith' (id: abc-123) does not have the 'Supplier' role. Available roles: ['Customer', 'Employee']. Use 'add_party_role' to assign the Supplier role first.",
  "suggestedTools": ["add_party_role", "list_party_roles", "find_party_by_name"],
  "context": { "partyId": "abc-123", "requiredRole": "Supplier" }
}
```

Errors must tell the AI **exactly what went wrong and how to fix it**.

### Principle 6: Context-Aware Responses

AI agents operate within token limits. Tools must return **scoped, relevant** data, not entire tables.

```
get_order({ orderId: "12345", include: ["lines", "statusHistory", "availableActions"] })
```

Not:
```
GET /api/orders/12345  →  returns 200KB with every possible relation
```

### Principle 7: Human-in-the-Loop Gates

Critical operations need confirmation boundaries:

| Operation | Risk Level | Gate |
|-----------|-----------|------|
| Create a customer | Low | Auto-approve |
| Post a journal entry | Medium | Require role check |
| Void a posted invoice | High | Require human confirmation |
| Delete GL account | Critical | Require human + 2FA confirmation |

**Implementation:** Each tool declares a `confirmationLevel`. The AI agent must escalate to a human when it hits a gate it can't satisfy.

### Principle 8: Every Action Is Auditable for AI Traceability

```sql
CREATE TABLE ai_action_log (
  id UUID PRIMARY KEY,
  agent_id TEXT NOT NULL,           -- which AI agent
  conversation_id TEXT,             -- which conversation
  user_id UUID REFERENCES party,   -- on behalf of which human
  tool_called TEXT NOT NULL,        -- e.g., "create_sales_order"
  tool_input JSONB NOT NULL,        -- what the AI sent
  tool_output JSONB,                -- what the system returned
  reasoning TEXT,                    -- AI's explanation of why (if available)
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

This is **beyond normal audit logs** — it captures the AI reasoning chain.

### Principle 9: Batch and Compound Operations

AI agents often need to do multi-step operations that should be atomic:

```
fulfill_and_invoice_order({ orderId: "12345" })
  → Internally: reserve inventory + create shipment + generate invoice + post to GL
```

These are **compound tools** — they orchestrate multiple domain services and return a unified result.

### Principle 10: Schema-as-Prompt (Self-Describing System)

The AI should be able to ask "what can I do?" and "what does this system know about?"

Tools:
- `list_available_tools()` — returns all tools with descriptions
- `describe_entity_type({ type: "order" })` — returns schema, fields, relationships, statuses, type table values
- `search_entities({ query: "customers in Berlin" })` — semantic search across all entities

---

## 3. Revised Architecture for Agentic AI

```
┌──────────────────────────────────────────────────────────────┐
│                      Users (Human)                            │
│                 ┌──────────┬──────────┐                       │
│                 │  Web UI  │ Chat UI  │                       │
│                 └────┬─────┴────┬─────┘                       │
│                      │          │                              │
│          ┌───────────▼──────────▼───────────┐                │
│          │        AI Agent Orchestrator       │                │
│          │  (Intent parsing, planning,        │                │
│          │   tool selection, execution)        │                │
│          └───────────────┬────────────────────┘                │
│                          │ tool calls                          │
│          ┌───────────────▼────────────────────┐               │
│          │         MCP Tool Server             │ ◄── NEW LAYER │
│          │  (Model Context Protocol —          │               │
│          │   semantic tool definitions,        │               │
│          │   validation, confirmation gates)   │               │
│          └───────────────┬────────────────────┘               │
│                          │                                     │
│          ┌───────────────▼────────────────────┐               │
│          │       Domain Services              │               │
│          │  (Business logic, pure functions)   │               │
│          └───────────────┬────────────────────┘               │
│                          │                                     │
│     ┌────────────────────▼────────────────────┐               │
│     │           Persistence + Events           │               │
│     │  (PostgreSQL + Event Bus + AI Action Log)│               │
│     └─────────────────────────────────────────┘               │
└──────────────────────────────────────────────────────────────┘
```

### Key New Layer: MCP Tool Server

The **Model Context Protocol (MCP) Tool Server** is the agentic AI interface. It:

1. **Exposes tools** with rich JSON Schema + natural language descriptions
2. **Validates inputs** against business rules before domain execution
3. **Enforces confirmation gates** (escalates to human when needed)
4. **Logs all AI actions** with reasoning chains
5. **Provides discovery tools** (`list_tools`, `describe_entity`, `search`)
6. **Returns actionable errors** with suggested next steps

---

## 4. How This Changes Silverstone's Data Model Implementation

### 4.1 Enhanced Type Tables

Every `_TYPE` table gets AI-facing metadata:

```sql
CREATE TABLE party_type (
  party_type_id UUID PRIMARY KEY,
  parent_type_id UUID REFERENCES party_type,  -- hierarchy
  name TEXT NOT NULL UNIQUE,                   -- e.g., "Customer"
  description TEXT NOT NULL,                   -- AI reads this
  ai_prompt_hint TEXT,                         -- "Use this type when the party buys goods"
  icon TEXT,                                   -- UI
  applicable_role_types JSONB,                 -- valid roles for this party type
  default_status_flow_id UUID,                 -- initial status path
  is_system BOOLEAN DEFAULT FALSE,             -- cannot be deleted
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 4.2 Enhanced Status Machines

```sql
CREATE TABLE status_valid_change (
  status_valid_change_id UUID PRIMARY KEY,
  from_status_id UUID REFERENCES status,
  to_status_id UUID REFERENCES status,
  entity_type TEXT NOT NULL,                   -- "ORDER", "INVOICE", etc.
  required_fields JSONB,                       -- fields that must be set for transition
  confirmation_level TEXT DEFAULT 'none',      -- none | role_check | human | human_2fa
  ai_instructions TEXT,                        -- "Check that all line items have inventory reserved"
  trigger_tool TEXT,                           -- the tool to call for this transition
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 4.3 Entity Descriptions Table (Schema-as-Prompt)

```sql
CREATE TABLE entity_descriptor (
  entity_name TEXT PRIMARY KEY,                -- "order", "invoice", "product"
  display_name TEXT NOT NULL,                  -- "Sales Order"
  description TEXT NOT NULL,                   -- AI-readable description
  ai_usage_guide TEXT,                         -- when/how an AI should interact with this entity
  schema_json JSONB NOT NULL,                  -- full JSON Schema of the entity
  example JSONB,                               -- example instance
  related_entities TEXT[],                     -- ["party", "order_item", "invoice"]
  available_tools TEXT[],                      -- ["create_order", "cancel_order", ...]
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 4.4 AI Action Audit (see Principle 8 above)

Already described — this is the most critical new table.

### 4.5 Confirmation Gate Registry

```sql
CREATE TABLE confirmation_gate (
  tool_name TEXT PRIMARY KEY,
  confirmation_level TEXT NOT NULL,            -- none | role_check | human | human_2fa
  confirmation_message TEXT NOT NULL,           -- "This will void a posted invoice. Confirm?"
  cooldown_seconds INT DEFAULT 0,              -- prevent rapid re-confirmation
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 5. Tool Design Patterns

### 5.1 CRUD Tools (per entity)

For each major entity, generate 6 standard tools:

| Tool | Purpose | Returns |
|------|---------|---------|
| `create_{entity}` | Create with validation | Created entity + available next actions |
| `get_{entity}` | Get by ID with optional includes | Entity + related data (scoped) |
| `update_{entity}` | Partial update | Updated entity + changed fields |
| `search_{entities}` | Filtered, paginated list | Results + total count + facets |
| `delete_{entity}` | Soft delete (if allowed) | Confirmation |
| `describe_{entity}` | Schema + types + statuses | Entity descriptor (no data) |

### 5.2 Action Tools (workflow-specific)

| Tool | Purpose |
|------|---------|
| `transition_{entity}_status` | Change status with validation |
| `get_valid_transitions` | What can I do next? |
| `add_{entity}_role` | Assign a role to a party |
| `add_{entity}_adjustment` | Add discount/tax/shipping |
| `post_{entity}` | Finalize (e.g., post invoice to GL) |
| `void_{entity}` | Reverse with reason |

### 5.3 Compound Tools (multi-step)

| Tool | Orchestrates |
|------|-------------|
| `create_customer_with_contacts` | create_party + add_role + create_contacts |
| `fulfill_and_invoice_order` | reserve_inventory + create_shipment + create_invoice + post_to_gl |
| `onboard_supplier` | create_party + add_role + create_contacts + setup_payment_terms |
| `month_end_close` | post_accruals + reconcile_inventory + generate_financials |

#### Compound Tool Failure Model (Saga Pattern)

Compound tools orchestrate multiple domain services. Partial failure is inevitable — the system must handle it correctly.

**Strategy: Orchestration-based saga with compensating transactions.**

```
fulfill_and_invoice_order({ orderId: "12345" })

Step 1: reserve_inventory     → SUCCESS (checkpoint)
Step 2: create_shipment       → SUCCESS (checkpoint)
Step 3: create_invoice        → FAILURE (tax calculation error)
Step 4: post_to_gl            → SKIPPED (step 3 failed)

Compensation:
  - Cancel shipment (reverse step 2)
  - Release inventory reservation (reverse step 1)

Return:
{
  "status": "failed",
  "failedStep": "create_invoice",
  "error": { ... rich error for AI ... },
  "compensations": [
    { "step": "cancel_shipment", "status": "completed" },
    { "step": "release_inventory", "status": "completed" }
  ],
  "suggestedNextSteps": [
    "Fix the tax configuration and retry with a new idempotency key",
    "Or fulfill the order without invoicing using 'create_shipment_only'"
  ]
}
```

**Implementation rules:**
1. Each step in a compound tool has a **compensating action** defined in the tool schema
2. Progress is **checkpointed** in the `idempotency_record` so retries resume from the failure point
3. Compensation actions are **best-effort** — if compensation fails, alert humans (don't silently fail)
4. All compound tool executions are logged to `ai_action_log` with full step-by-step detail
5. The AI agent receives a rich failure response with the system state after compensation

### 5.4 Discovery Tools (AI self-service)

| Tool | Purpose |
|------|---------|
| `list_available_tools` | What can I do? |
| `describe_entity_type` | What does this entity look like? |
| `get_type_table_values` | What are valid values for ORDER_TYPE? |
| `search_across_entities` | Universal search |
| `explain_error` | Given an error code, explain how to fix it |

#### Token Budget Awareness

Discovery tools can return large payloads that exceed an agent's context window. All discovery tools must support **response scoping**:

```
describe_entity_type({
  type: "order",
  detail: "summary"   // summary | full | schema_only
})

get_type_table_values({
  type: "PARTY_TYPE",
  limit: 10,          // max rows to return
  filter: { "name": { "startsWith": "C" } }
})
```

| Detail level | Token estimate | When to use |
|-------------|---------------|-------------|
| `schema_only` | ~200 tokens | Agent just needs field names/types |
| `summary` | ~500 tokens | Agent needs overview + key relationships |
| `full` | ~2000 tokens | Agent is about to create/update the entity |

All discovery tool responses include a `truncated` flag and `totalAvailable` count so the agent knows if it's seeing partial data.

---

## 6. Revised Tech Stack Additions

| Layer | Addition | Why |
|-------|----------|-----|
| **Tool Protocol** | **MCP (Model Context Protocol)** | Standard protocol for exposing tools to AI agents |
| **Agent Runtime** | **LangChain / LlamaIndex / custom** | Orchestrates tool calls, manages conversation |
| **Vector Search** | **pgvector (PostgreSQL extension)** | Semantic search across entities without separate ES |
| **Embeddings** | **OpenAI / local model** | Generate embeddings for semantic search |
| **AI Action Store** | **New PostgreSQL schema** | All AI audit, reasoning, feedback data |
| **Confirmation UI** | **WebSocket + notification system** | Real-time human confirmation gates |

---

## 7. Testing Strategy for AI Agents

Traditional ERP testing is `input → assertion`. Agentic testing is `intent → outcome`.

| Test Type | Description |
|-----------|-------------|
| **Tool Contract Tests** | Each tool: valid input → expected output schema |
| **Error Recovery Tests** | Each tool: invalid input → rich error → AI can self-correct |
| **Workflow Discovery Tests** | `get_valid_transitions` returns correct options at each state |
| **Idempotency Tests** | Same idempotency key → same result, no duplicates |
| **Confirmation Gate Tests** | High-risk tools correctly escalate |
| **End-to-End Agent Tests** | AI agent completes full workflows (e.g., "create an order for Acme Corp") |
| **Hallucination Guard Tests** | AI cannot call tools that don't exist or create invalid entity types |
| **Multi-step Reasoning Tests** | Compound tools return correct intermediate states |

#### Hallucination Guard Implementation

AI agents may fabricate tool names, entity IDs, or type values. The system must detect and reject these.

**Layer 1: Tool name validation** — The MCP server rejects calls to undefined tools with a rich error:
```json
{
  "error": "UNKNOWN_TOOL",
  "message": "Tool 'create_purchase_requisition' does not exist. Similar tools: ['create_purchase_order', 'create_order']. Use 'list_available_tools' to see all available tools.",
  "suggestedTools": ["create_purchase_order", "create_order", "list_available_tools"]
}
```

**Layer 2: Entity ID validation** — Every tool that accepts entity IDs validates them against the database:
```json
{
  "error": "ENTITY_NOT_FOUND",
  "message": "Party with ID 'abc-fake-123' does not exist. Use 'search_parties' to find valid parties.",
  "suggestedTools": ["search_parties", "get_party"]
}
```

**Layer 3: Type value validation** — All type references are validated against TYPE tables. The agent receives the valid alternatives:
```json
{
  "error": "INVALID_TYPE_VALUE",
  "message": "ORDER_TYPE 'rush_order' is not a valid type. Valid types: ['sales_order', 'purchase_order', 'return_order'].",
  "validValues": ["sales_order", "purchase_order", "return_order"],
  "suggestedTool": "get_type_table_values"
}
```

**Layer 4: Semantic similarity check** — For common hallucinations, use embedding similarity to suggest the correct tool or value.

---

## 8. Security Model for AI Agents

```
┌─────────────────────────────────────────┐
│             Human User                   │
│  Roles: [Admin, Sales, Accounting]       │
│  Permissions: [create_order, post_gl]    │
└─────────────┬───────────────────────────┘
              │ delegates to
┌─────────────▼───────────────────────────┐
│             AI Agent                     │
│  Runs AS the human (inherits perms)      │
│  + Agent-specific restrictions:          │
│    - Max transaction amount              │
│    - Allowed entity types                │
│    - Rate limits                         │
│    - Cannot bypass confirmation gates    │
│    - Must log all actions                │
└─────────────┬───────────────────────────┘
              │ calls
┌─────────────▼───────────────────────────┐
│          MCP Tool Server                 │
│  Enforces:                               │
│    - User permissions                    │
│    - Agent restrictions                  │
│    - Confirmation gates                  │
│    - Audit logging                       │
└─────────────────────────────────────────┘
```

Key rule: **The AI agent never has MORE permission than the human it acts on behalf of.** It may have LESS (agent restrictions), but never more.

### 8.1 Agent Registry

Every AI agent must be registered before it can use the system.

```sql
CREATE TABLE agent_registry (
  agent_id TEXT PRIMARY KEY,              -- e.g., "sales-assistant-v1"
  display_name TEXT NOT NULL,             -- e.g., "Sales Assistant"
  description TEXT NOT NULL,              -- AI-readable description of this agent's purpose
  capabilities TEXT[],                    -- ["create_order", "search_customers", ...]
  max_tool_calls_per_conversation INT DEFAULT 100,
  max_concurrent_conversations INT DEFAULT 5,
  max_transaction_amount DECIMAL(19,4),  -- per-operation financial limit
  allowed_entity_types TEXT[],            -- ["order", "party", "invoice"]
  rate_limit_per_minute INT DEFAULT 30,
  version TEXT NOT NULL,                 -- semantic version
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 8.2 Rate Limiting & Cost Control

AI agents can call tools thousands of times. Controls are essential.

| Control | Default | Configurable per agent | Purpose |
|---------|---------|----------------------|----------|
| Tool calls per conversation | 100 | Yes | Prevent infinite loops |
| Tool calls per minute | 30 | Yes | Prevent flooding |
| Concurrent conversations | 5 | Yes | Prevent resource exhaustion |
| Max transaction amount | $10,000 | Yes | Limit financial exposure |
| Conversation timeout | 30 min | Yes | Abandon stale sessions |

**Cost tracking:**

```sql
CREATE TABLE agent_usage (
  id UUID PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agent_registry(agent_id),
  conversation_id TEXT NOT NULL,
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  tool_called TEXT NOT NULL,
  tokens_used INT,                    -- estimated tokens consumed
  latency_ms INT,                     -- tool execution time
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

Dashboard: total tool calls per agent per day, average latency, error rate, estimated token cost. Alert if any agent exceeds 80% of its rate limit budget.

### 8.3 Embedding Strategy

pgvector is used for semantic search. The embedding strategy:

| What gets embedded | When | Model | Purpose |
|-------------------|------|-------|----------|
| Entity name + description | On create/update | text-embedding-3-small (or local) | Semantic entity search |
| Type table name + ai_prompt_hint | On seed/update | text-embedding-3-small (or local) | Type discovery via meaning |
| Tool name + description | On registration | text-embedding-3-small (or local) | Tool suggestion for hallucinated tool names |

Embeddings are stored in the entity's table (e.g., `party.embedding VECTOR(1536)`) and queried with cosine similarity.

**Key rule:** Embeddings are generated server-side (never by the agent) and are tenant-scoped.

---

## 9. Summary: What Changes from the Original Plan

| Area | Traditional ERP | Agentic AI ERP |
|------|----------------|----------------|
| **Primary interface** | REST API | MCP Tool definitions |
| **Endpoint design** | CRUD-oriented | Intent-oriented (named tools) |
| **Type tables** | Just data rows | Data + AI-readable descriptions + examples |
| **Status machines** | Code-driven | Queryable, discoverable, with AI instructions |
| **Error handling** | HTTP status codes | Rich, actionable errors with suggested tools |
| **Multi-step ops** | Client orchestrates | Compound tools server-side |
| **Audit** | Who/what/when | Who/what/when/why (AI reasoning) |
| **Search** | Filter params | Semantic search + traditional filters |
| **Security** | Role-based | Role-based + agent restrictions + confirmation gates |
| **Testing** | Unit/integration | + Agent workflow tests + hallucination guards |
| **Schema** | Internal | Self-describing (schema-as-prompt) |
| **Idempotency** | Optional | Mandatory for all write tools |
| **Database** | PostgreSQL | PostgreSQL + pgvector + AI action schema |

---

## 10. Implementation Plan

The full phased implementation plan, including the agentic AI layer tasks, is in [ERP_PLAN.md](./ERP_PLAN.md) — Section 5 (Phase 0, now split into Phase 0a–0d).

### Tool-First Development Workflow

For every new entity/module:
1. **Define the entity descriptor** (schema, description, examples)
2. **Define the tools** (names, input/output schemas, descriptions)
3. **Define the type table values** (with AI descriptions)
4. **Define the status machine** (with AI instructions)
5. **Define compound tool sagas** (steps + compensating actions)
6. **Implement the domain service** (pure business logic)
7. **Wire the tools** to the domain service
8. **Write tool contract tests**
9. **Write agent workflow tests**
10. **Write hallucination guard tests**

This is **tool-design-first development** — before writing a single line of domain code, you define how an AI agent would interact with it.

### Architecture Decision Records

Key decisions are documented in `docs/architecture/`:
- [ADR-001: MCP as Primary Agent Interface](./docs/architecture/adr-001-mcp-tool-protocol.md)
- [ADR-002: Row-Level Security for Multi-Tenancy](./docs/architecture/adr-002-rls-multi-tenancy.md)
- [ADR-003: Class Table Inheritance for Supertype/Subtype](./docs/architecture/adr-003-class-table-inheritance.md)
- [ADR-004: Idempotency Key Pattern for Write Tools](./docs/architecture/adr-004-idempotency-key-pattern.md)
