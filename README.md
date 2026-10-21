# BestERP - Enterprise Resource Planning System

A modern, AI-powered ERP system with multi-tenant architecture, built with NestJS and Prisma.

## Features

- **Multi-tenant architecture** with Row-Level Security (RLS)
- **AI Agent Integration** via MCP (Model Context Protocol) tools
- **Domain-driven design** with clean separation of concerns
- **Comprehensive error handling** with structured domain errors
- **Type-safe** with TypeScript and Zod validation
- **Production-ready** with security best practices

## Project Structure

```
besterp/
├── apps/
│   └── api/                 # NestJS API application
│       └── src/
│           ├── modules/        # Domain modules (party, product, security)
│           ├── mcp/tools/      # MCP tool definitions
│           ├── auth/           # Authentication & authorization
│           ├── prisma/         # Database service
│           └── common/         # Shared utilities
├── packages/
│   ├── shared/                # Shared utilities (errors, crypto, validation)
│   ├── database/             # Database utilities & RLS extension
│   └── mcp-tools/            # MCP tool framework
├── docker/                   # Docker Compose configuration
├── docs/                     # Project design documents
├── CHANGES.md                # Iterative change log
└── CODE_REVIEW_REPORT.md     # Code review history
```

## Recent Improvements

### Enhanced Error Handling
- **Structured domain errors** with machine-readable codes
- **Comprehensive input validation** with detailed error messages
- **Context-aware error handling** with suggested next actions
- **Consistent error patterns** across all services

### Security Improvements
- **Enhanced tenant validation** with SQL injection protection
- **Input sanitization** for all user-provided data
- **Comprehensive error context** for debugging
- **Defense-in-depth** validation at multiple levels

### Expanded Test Coverage
- **Unit tests for business logic** (PartyService, MCP tools)
- **Integration tests** for middleware and tool registry
- **Database validation tests** for RLS functionality
- **Crypto utility tests** for data integrity

### Performance Optimizations
- **Query optimization** with better indexing strategies
- **Pagination handling** with proper limits and offsets
- **Efficient data validation** with early rejection
- **Transaction management** for data consistency

## Development

### Running Tests

```bash
# Run all tests across all workspaces
npm test

# Run tests in a specific workspace
npm test --workspace=@besterp/api
npm test --workspace=@besterp/shared
npm test --workspace=@besterp/mcp-tools
npm test --workspace=@besterp/database
```

### Code Quality

```bash
# Run linting across all workspaces
npm run lint

# Run type checking across all workspaces
npm run typecheck

# Build all workspaces
npm run build
```

### Database

```bash
# Generate Prisma client
npm run db:generate

# Run database migrations
npm run db:migrate

# Seed database with test data
npm run db:seed
```

## Architecture

### Multi-Tenant Security
- **Row-Level Security (RLS)** enforced at database level
- **Dual database connections** (admin vs application roles)
- **Tenant-scoped Prisma clients** with automatic context setting
- **Defense-in-depth** with application-level filtering

### AI Agent Integration
- **MCP tool framework** for AI agent interactions
- **Structured tool definitions** with Zod schemas
- **Middleware pipeline** for idempotency, audit logging, and error handling
- **Discovery tools** for AI self-service capabilities

### Domain-Driven Design
- **Clean separation** of business logic and infrastructure
- **Rich domain models** with proper encapsulation
- **Direct Prisma service calls** with RLS-scoped clients
- **No repository abstraction** — domain services own their data access

## Security Features

### Input Validation
- **Zod schemas** for all API inputs
- **Tenant ID validation** with SQL injection protection
- **Email format validation** with regex patterns
- **Data sanitization** for all user inputs

### Error Handling
- **Domain error classes** with structured codes
- **Context preservation** for debugging
- **User-friendly messages** without exposing sensitive data
- **AI agent suggestions** for error recovery

### Data Protection
- **Row-level security** prevents cross-tenant data access
- **Optimistic concurrency** prevents lost updates
- **Audit logging** tracks all data modifications
- **Idempotency keys** prevent duplicate operations

## Getting Started

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Set up environment variables**
   ```bash
   cp .env.example .env
   # No changes needed for local development — defaults match docker compose
   ```

   Then export the variables into your shell before running any npm/compose
   command below. The workspace scripts do NOT auto-load the repo-root `.env`:
   `prisma` only looks in `packages/database`, the seed runs via `tsx` (which
   loads no `.env` at all), and `docker compose` reads `.env` from the
   `docker/` directory. Exporting once fixes every consumer:
   ```bash
   set -a; source .env; set +a
   ```

3. **Start infrastructure** (PostgreSQL, Redis, MinIO)
   ```bash
   cd docker && docker compose up -d
   ```

4. **Generate Prisma client**
   ```bash
   npm run generate --workspace=@besterp/database
   ```

5. **Run database migrations, apply RLS, and seed**

   The compose init script creates the `besterp_app` role, but Row-Level Security
   (`rls-setup.sql`) must be applied **after** migrations because it enables
   RLS on tables that migrations create. The seed inserts hard-coded test
   tenants and refuses to run without an explicit opt-in (`ALLOW_SEED=1`):
   ```bash
   npm run db:migrate
   docker exec -i besterp-postgres psql -v ON_ERROR_STOP=1 -U besterp -d besterp -f /setup/rls-setup.sql
   ALLOW_SEED=1 npm run db:seed
   ```

   `ON_ERROR_STOP=1` is required: without it `psql` exits `0` even when a
   statement fails, so a malformed policy leaves the database without RLS
   while the command appears to succeed.

   The API **refuses to boot** if RLS is not enabled (and forced) on every
   tenant-scoped table — including `user` and `agent_registry`, which store
   password hashes and agent configuration — or if a tenant table has RLS
   enabled but **no policy** (PostgreSQL then denies every row on it).
   Re-apply `rls-setup.sql` after pulling changes that add a tenant-scoped
   table, and after any migration that recreates one.

6. **Run the application**
    ```bash
    npm run start:dev --workspace=@besterp/api
    ```
    The start scripts build the workspace packages first — the API resolves
    `@besterp/shared` / `@besterp/mcp-tools` / `@besterp/database` through
    their published build output.

7. **Access the health endpoint**
   ```bash
   curl http://localhost:3000/api/health
   ```

## API Documentation

### Party Management
- `POST /api/parties` - Create new party (person/organization)
- `GET /api/parties/:id` - Get party by ID
- `GET /api/parties` - Search parties with filters
- `POST /api/parties/:id/roles` - Add role to party
- `POST /api/parties/:id/contacts` - Add contact mechanism

### MCP Tools

The MCP tool registry is the primary agent interface (ADR-001). It is
reachable over HTTP at:

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/api/mcp/tools` | List the registered tools (name, description, risk level, entity, tags, `confirmationRequired`) |
| `POST` | `/api/mcp/tools/call` | Invoke a tool — the MCP `tools/call` request shape |
| `POST` | `/api/mcp/tools/:name` | Invoke a tool with the name in the path |

All three endpoints require a JWT (the global `JwtAuthGuard` +
`TenantGuard` apply); the tenant and user identity come from the validated
token, never from the request body.

`GET /api/mcp/tools` returns the SAME payload as the `list_available_tools`
MCP tool, including the `confirmationRequired` flag for each tool.

For `POST /api/mcp/tools/:name` the tool name comes from the URL, so the
request body does NOT need a `name` field. If the body carries one, it must
match the path — a mismatch is rejected with HTTP 400 rather than silently
resolved in favour of one of the two.

```bash
curl -X POST http://localhost:3000/api/mcp/tools/call \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "create_party",
        "arguments": {
          "partyType": "PERSON",
          "name": "Jane Doe",
          "person": { "firstName": "Jane", "lastName": "Doe" }
        },
        "reasoning": "The customer asked for a new contact"
      }'
```

The response body is the tool result verbatim
(`{ "success": true, "data": … }` or `{ "success": false, "error": { "code",
"message", "suggestedTools", "context" } }`). The HTTP status reports the
transport outcome; the tool's own outcome is in the body — the MCP
convention.

**Discovery**
- `list_available_tools` - Discover available tools (includes risk level and whether a confirmation is required)
- `get_type_table_values` - Get valid type values
- `describe_entity` - Describe an entity's fields and semantics
- `get_valid_transitions` - Get valid status transitions for an entity (only entities that expose a status field AND have a transition tool are listed)
- `search_across_entities` - Universal search across entity types
- `explain_error` - Explain an error code and suggest recovery steps

**Party**
- `create_party` - Create party with validation
- `get_party` - Retrieve party details
- `search_parties` - Search with filters and pagination
- `add_party_role` - Assign roles to parties
- `add_contact_mechanism` - Add contact information

**Product**
- `create_product` - Create a product
- `get_product` - Retrieve a product with features and prices
- `search_products` - Search products with filters and pagination
- `update_product` - Update a product's name, description, SKU or type
- `add_product_feature` - Add a key/value feature to a product
- `add_product_price` - Add a price to a product

**Agent registry**
- `register_agent` - Register an AI agent identity
- `list_agents` - List registered agents
- `describe_agent` - Describe an agent's configuration
- `update_agent` - Update an agent's configuration
- `deactivate_agent` - Deactivate an agent (soft delete)
- `delete_agent` - Permanently delete an agent

An agent identity is ENFORCED on every tool call. When the JWT carries an
`agentId`, the call is rejected unless the agent is registered in the
tenant, is active, and lists the tool in its `capabilities` (the schema
documents that field as "List of tool names this agent is allowed to call").
A rejected call is still recorded in the durable audit trail.

The per-minute rate limit, the per-conversation tool-call cap and the
per-operation transaction amount are RECORDED on the agent but are not yet
enforced — they need a durable per-agent usage counter that the schema does
not have yet.

**User**
- `get_user` - Read the user account linked to a party (never returns the password hash)
- `create_user` - Create a user account for an existing party

`create_user` is the only write path to the `user` table — the table that
stores the system's only credentials — so it validates that `passwordHash`
is a **bcrypt or argon2 digest**. A plaintext password is rejected.

#### Envelope fields

Two arguments are handled by the framework rather than by the tool schemas,
so they are accepted on every tool:

- `idempotencyKey` (string) — deduplicates retries of a write. The same key
  with the same input replays the stored result; a different input under the
  same key is rejected with `IDEMPOTENCY_KEY_MISMATCH`.
- `confirmation` (string, ≥ 10 characters) — required by tools whose
  confirmation gate is enabled (the high-risk write tools). It explains why
  the agent believes the operation should proceed and is persisted to the
  audit trail. `list_available_tools` reports which tools require it.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes with comprehensive tests
4. Run the test suite
5. Submit a pull request

## License

This project is licensed under the MIT License - see the LICENSE file for details.
