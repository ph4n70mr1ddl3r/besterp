# ADR-001: MCP (Model Context Protocol) as the Primary Agent Interface

**Status:** Accepted  
**Date:** 2026-05-10  
**Deciders:** Architecture team  
**Related:** AGENTIC_AI_DESIGN.md Principles 1-10

---

## Context

BestERP's primary users are AI agents. We need a protocol for exposing business operations (create order, post invoice, search customers, etc.) to AI agents in a way that is:

- **Semantically clear** — agents understand what each operation does
- **Self-describing** — agents can discover available operations at runtime
- **Standardized** — not a proprietary API that locks us into one LLM provider
- **Rich enough** — supports validation, confirmation gates, audit logging, and rich errors

## Decision

We adopt the **Model Context Protocol (MCP)** as the primary interface for AI agent interaction with BestERP.

### Transport:

| Transport | Use Case | When |
|-----------|----------|------|
| **stdio** | Local development, embedded agents, CLI tools | Now (spike validated) |
| **Streamable HTTP** | Production API gateway, remote agents, multi-agent orchestration | Phase 0b |

The spike validated stdio transport. For production, we'll add Streamable HTTP support so the MCP server can sit behind an API gateway and serve remote agents over HTTP.

### What this means concretely:

1. **Every business operation is an MCP tool** — not a REST endpoint or GraphQL mutation
2. **Tool definitions live in `packages/mcp-tools/`** (canonical source, imported by the API server)
3. **REST and GraphQL are secondary interfaces** — they consume the same domain services but are not the primary design surface
4. **The MCP server handles**:
   - Input validation (JSON Schema)
   - Confirmation gate enforcement
   - Audit logging (ai_action_log)
   - Idempotency key checking
   - Rich error formatting

### Tool definition anatomy:

```typescript
{
  name: "create_sales_order",
  description: "Creates a new sales order for a customer. Requires at least one line item. Use 'get_type_table_values' with type 'ORDER_TYPE' to see valid order types.",
  inputSchema: {
    type: "object",
    properties: {
      idempotencyKey: { type: "string", description: "Unique key to prevent duplicates" },
      customerId: { type: "string", format: "uuid" },
      orderTypeId: { type: "string", format: "uuid" },
      lineItems: { type: "array", items: { ... } },
      shipToPartyId: { type: "string", format: "uuid" }
    },
    required: ["idempotencyKey", "customerId", "orderTypeId", "lineItems"]
  },
  confirmationLevel: "none",
  annotations: {
    module: "mod-sales",
    entity: "order",
    operation: "create",
    riskLevel: "low"
  }
}
```

## Alternatives Considered

| Alternative | Pros | Cons | Verdict |
|-------------|------|------|---------|
| **OpenAI Function Calling** | Mature, well-documented | Proprietary to OpenAI, single provider | ❌ Vendor lock-in |
| **Custom tool protocol** | Full control | No ecosystem, reinventing the wheel, every agent framework needs custom integration | ❌ Not worth the cost |
| **REST + OpenAPI only** | Universal, existing tooling | Not designed for agent interaction; no built-in discovery, confirmation, or rich error semantics | ❌ Wrong abstraction level |
| **GraphQL only** | Great for reads, self-documenting schema | Not designed for agentic workflows (confirmation gates, idempotency, audit) | ❌ Good for reports, not for agents |
| **MCP** | Open standard, model-agnostic, designed for tool use, growing ecosystem | Young protocol, still evolving | ✅ Best fit |

## Consequences

### Positive
- Agents can discover tools at runtime (`list_available_tools`, `describe_entity_type`)
- Tool descriptions are part of the protocol — no separate documentation drift
- Model-agnostic: works with OpenAI, Anthropic, open-source models, any MCP client
- Growing ecosystem of MCP clients and tooling

### Negative
- MCP is a young protocol — may have breaking changes
- Additional infrastructure (MCP server alongside REST/GraphQL)
- Team needs to learn MCP conventions and patterns
- REST/GraphQL consumers get a slightly degraded experience (tools are designed for agents first)

### Mitigations
- Pin MCP SDK version; evaluate updates before adopting
- REST/GraphQL handlers call the same domain services — no logic duplication
- Invest in tool contract tests early to catch breaking changes

## References

- [Model Context Protocol Specification](https://modelcontextprotocol.io/)
- AGENTIC_AI_DESIGN.md — Principles 1, 3, 5, 7
- ERP_PLAN.md — Section 7, Decision 9
