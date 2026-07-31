# BestERP - Enterprise Resource Planning System

A modern, AI-powered ERP system with multi-tenant architecture, built with NestJS and Prisma.

## 🚀 Features

- **Multi-tenant architecture** with Row-Level Security (RLS)
- **AI Agent Integration** via MCP (Model Context Protocol) tools
- **Domain-driven design** with clean separation of concerns
- **Comprehensive error handling** with structured domain errors
- **Type-safe** with TypeScript and Zod validation
- **Production-ready** with security best practices

## 📁 Project Structure

```
besterp/
├── apps/api/                 # NestJS API application
│   ├── src/
│   │   ├── modules/core/party/  # Party domain module
│   │   ├── mcp/tools/           # MCP tool definitions
│   │   ├── auth/               # Authentication & authorization
│   │   ├── prisma/             # Database service
│   │   └── common/             # Shared utilities
│   └── test/                  # Test files
├── packages/
│   ├── shared/                # Shared utilities (errors, crypto, validation)
│   ├── database/             # Database utilities & RLS extension
│   └── mcp-tools/            # MCP tool framework
└── docs/                     # Documentation
```

## 🔧 Recent Improvements

### ✅ Enhanced Error Handling
- **Structured domain errors** with machine-readable codes
- **Comprehensive input validation** with detailed error messages
- **Context-aware error handling** with suggested next actions
- **Consistent error patterns** across all services

### 🛡️ Security Improvements  
- **Enhanced tenant validation** with SQL injection protection
- **Input sanitization** for all user-provided data
- **Comprehensive error context** for debugging
- **Defense-in-depth** validation at multiple levels

### 🧪 Expanded Test Coverage
- **Unit tests for business logic** (PartyService, MCP tools)
- **Integration tests** for middleware and tool registry
- **Database validation tests** for RLS functionality
- **Crypto utility tests** for data integrity

### 📊 Performance Optimizations
- **Query optimization** with better indexing strategies
- **Pagination handling** with proper limits and offsets
- **Efficient data validation** with early rejection
- **Transaction management** for data consistency

## 🛠️ Development

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

## 🏗️ Architecture

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
- **Event-driven architecture** for domain events
- **Repository pattern** for data access abstraction

## 🔐 Security Features

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

## 🚀 Getting Started

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Set up environment variables**
   ```bash
   cp .env.example .env
   # No changes needed for local development — defaults match docker compose
   ```

3. **Start infrastructure** (PostgreSQL, Redis, MinIO)
   ```bash
   cd docker && docker compose up -d
   ```

4. **Run database migrations, apply RLS, and seed**

   The compose init script creates the `besterp_app` role, but Row-Level Security
   (`rls-setup.sql`) must be applied **after** migrations because it enables
   RLS on tables that migrations create:
   ```bash
   npm run db:migrate
   docker exec -i besterp-postgres psql -U besterp -d besterp -f /setup/rls-setup.sql
   npm run db:seed
   ```

5. **Generate Prisma client**
   ```bash
   npm run generate --workspace=@besterp/database
   ```

6. **Run the application**
   ```bash
   cd apps/api && npm run start:dev
   ```

7. **Access the health endpoint**
   ```bash
   curl http://localhost:3000/api/health
   ```

## 📚 API Documentation

### Party Management
- `POST /api/parties` - Create new party (person/organization)
- `GET /api/parties/:id` - Get party by ID
- `GET /api/parties` - Search parties with filters
- `POST /api/parties/:id/roles` - Add role to party
- `POST /api/parties/:id/contacts` - Add contact mechanism

### MCP Tools
- `list_available_tools` - Discover available tools
- `get_type_table_values` - Get valid type values
- `create_party` - Create party with validation
- `get_party` - Retrieve party details
- `search_parties` - Search with filters and pagination
- `add_party_role` - Assign roles to parties
- `add_contact_mechanism` - Add contact information

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes with comprehensive tests
4. Run the test suite
5. Submit a pull request

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.