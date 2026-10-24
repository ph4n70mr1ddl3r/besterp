// MCP Tool Registry — Central registration point for all MCP tools.
//
// Tools are registered with their definition and middlewares.
// The registry compiles the middleware pipeline and provides lookup
// by name. It also generates discovery information for AI agents.

import {
  ToolDefinition,
  ToolMiddleware,
  RegistryEntry,
  ToolResult,
  ToolContext,
  RiskLevel,
} from "../schema/tool-definition.js";
import {
  sanitizeForLogOutput,
  redactSensitiveFieldValues,
  validateTenantIdEnhancedForAuth,
  MAX_USER_ID_LENGTH,
  MAX_AGENT_ID_LENGTH,
  MAX_CONVERSATION_ID_LENGTH,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_VALIDATION_ISSUES,
  MAX_VALIDATION_ISSUE_MESSAGE_LENGTH,
  isSensitiveFieldName,
  isValidOptionalId,
} from "@besterp/shared";
import { sanitizeAgentFacingResult, capAgentErrorText, truncateAtCharacterBoundary } from "../agent-result.js";
import { sanitizeDurableIdentity } from "../identity.js";
import { IDEMPOTENCY_KEY_MISMATCH, INVALID_CONTEXT_ID, INVALID_TENANT_ID, INVALID_USER_ID, UNKNOWN_TOOL } from "../error-codes.js";

/** Permissive pattern for optional identity fields (userId, agentId, conversationId).
 *  More lenient than TENANT_ID_PATTERN to accommodate real-world identifiers
 *  (e.g. john.doe, user+role) while still rejecting control characters and
 *  zero-width/bidi sequences (JS \s does NOT cover these) that could confuse
 *  downstream sanitization or make two visually-identical IDs hash to
 *  different idempotency composite keys. Defined in @besterp/shared for reuse
 *  by auth boundaries (JwtStrategy) and the MCP tool registry. */

const VALID_RISK_LEVELS: readonly RiskLevel[] = ["none", "low", "medium", "high", "critical"];

/**
 * The argument names the FRAMEWORK owns.
 *
 * They are promoted into the tool context and stripped from the input before
 * validation (see {@link ToolRegistry.stripEnvelopeKeys}), so a tool must
 * not declare them in its own input schema.
 */
const ENVELOPE_KEYS = ["idempotencyKey", "confirmation"] as const;

/**
 * A rejection that happens BEFORE the middleware pipeline runs.
 *
  * The pipeline is composed per tool, so a rejection that happens before the
  * tool is even looked up (an unknown tool name, a conflicting idempotency
  * key) never reaches the audit middleware. A hallucinated tool call is one
  * of the most useful agent-behaviour signals an ERP has, so it must be
  * recorded; the audit row is tenant-scoped (RLS), so it is only written
  * when the tenant id validated.
 */
export interface ToolCallRejection {
  /** The tool name the caller asked for. */
  toolName: string;
  /** The validated caller identity. */
  context: ToolContext;
  /** The machine-readable rejection code (e.g. "UNKNOWN_TOOL"). */
  code: string;
  /** The human-readable rejection message. */
  message: string;
  /** The raw tool arguments, when they are available. */
  input?: unknown;
}

/**
 * A callback that records a pre-pipeline rejection in a durable sink.
 *
 * It is invoked at most once per rejected call and MUST NOT throw — the
 * registry swallows any error it raises so an audit sink can never change
 * the outcome of a call.
 */
export type RejectionAuditor = (rejection: ToolCallRejection) => void;

export class ToolRegistry {
  private readonly tools = new Map<string, RegistryEntry>();
  private readonly globalMiddlewares: ToolMiddleware[] = [];
  /** The NAMES of the registered global middlewares, in pipeline order. */
  private readonly globalMiddlewareNames: string[] = [];
  /** Optional sink for calls rejected before the pipeline was composed. */
  private rejectionAuditor?: RejectionAuditor;
  /** Cached compiled pipelines per tool name, invalidated on register/addGlobalMiddleware. */
  private readonly pipelineCache = new Map<string, (input: unknown, ctx: ToolContext) => Promise<ToolResult>>();

  /**
   * Register a global middleware that runs for ALL tools.
   * Global middlewares run BEFORE tool-specific middlewares.
   *
   * @param middleware the middleware function
   * @param name a short stage name (e.g. "auditLog"). The names are exposed
   *   through {@link ToolRegistry.globalMiddlewareOrder} so the composition
   *   can be ASSERTED against the published pipeline contract
   *   (`PRODUCTION_PIPELINE_ORDER`) instead of being asserted only in a
   *   comment that can drift from the code.
   */
  addGlobalMiddleware(middleware: ToolMiddleware, name?: string): void {
    this.globalMiddlewares.push(middleware);
    this.globalMiddlewareNames.push(name ?? `middleware-${this.globalMiddlewareNames.length + 1}`);
    this.pipelineCache.clear();
  }

  /**
   * The stage names of the registered global middlewares, outermost first.
   *
   * The published contract is `PRODUCTION_PIPELINE_ORDER`; this list is the
   * implementation's actual composition. A consumer can compare the two and
   * fail loudly when they diverge — the pipeline order carries SECURITY
   * meaning (the agent policy must run before the confirmation gate, the
   * audit log must wrap every guard), so a silent drift is not acceptable.
   */
  get globalMiddlewareOrder(): readonly string[] {
    return [...this.globalMiddlewareNames];
  }

  /**
   * Register the callback that records a call rejected BEFORE the pipeline
   * ran (an unknown tool name, a conflicting idempotency key).
   *
   * Those rejections happen before the pipeline is composed, so the audit
   * middleware — which wraps every guard — never sees them. Wiring the
   * auditor here closes the gap for every caller of `execute`, not just the
   * HTTP controller. The audit row is tenant-scoped (RLS), so it is only
   * written when the tenant id validated.
   */
  setRejectionAuditor(auditor: RejectionAuditor): void {
    this.rejectionAuditor = auditor;
  }

  /**
   * Record a pre-pipeline rejection. Never throws: an audit sink failure
   * must not change the outcome of the call.
   */
  private auditRejection(rejection: ToolCallRejection): void {
    if (!this.rejectionAuditor) return;
    try {
      this.rejectionAuditor(rejection);
    } catch {
      // The audit path must never break the call it is recording.
    }
  }

  /**
   * Record a call that was rejected because its caller identity is invalid.
   *
   * The rejection is only recorded when the TENANT id is valid, because the
   * durable audit row is tenant-scoped (row-level security) and there is no
   * tenant to attribute the attempt to when the tenant id is what failed.
   *
   * The invalid field is redacted: its VALUE may be attacker-controlled and
   * may embed a secret, and the audit trail must not become a second leak
   * path. The row records WHICH field failed, not what it contained.
   */
  private auditIdentityRejection(
    toolName: string,
    context: ToolContext,
    auth: { error: ToolResult; rejection?: { code: string; field: string } },
  ): void {
    const rejection = auth.rejection;
    if (!rejection) return;
    let tenantId: string;
    try {
      tenantId = validateTenantIdEnhancedForAuth(context.tenantId);
    } catch {
      // No valid tenant — the row could not be attributed (and the RLS
      // policy would deny the write anyway).
      return;
    }
    const safeName = sanitizeForLogOutput(toolName).slice(0, MAX_ERROR_MESSAGE_LENGTH);
    this.auditRejection({
      toolName: safeName,
      context: { ...context, tenantId },
      code: rejection.code,
      message: `The request ${rejection.field} is invalid.`,
      input: undefined,
    });
  }

  /**
   * Register a tool with optional tool-specific middlewares.
   */
  register(definition: ToolDefinition, middlewares: ToolMiddleware[] = []): void {
    // Validate tool name format FIRST so errors point at the real issue, not
    // at "already registered" when the name is actually invalid.
    if (!definition.name || typeof definition.name !== "string") {
      throw new Error("Tool name must be a non-empty string.");
    }
    if (!definition.description || typeof definition.description !== "string" || definition.description.trim().length === 0) {
      throw new Error(
        `Tool '${definition.name}' must have a non-empty description. ` +
        `The description helps AI agents understand the tool's purpose.`
      );
    }
    // Check reserved prefix FIRST to provide a specific error message — the
    // snake_case regex below would also reject `__` with a generic error.
    if (definition.name.startsWith("__")) {
      throw new Error(`Tool name '${definition.name}' must not start with '__' (reserved prefix).`);
    }
    if (!/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(definition.name)) {
      throw new Error(
        `Tool name '${definition.name}' must be snake_case (lowercase letters, digits, underscores).`
      );
    }

    if (this.tools.has(definition.name)) {
      throw new Error(`Tool '${definition.name}' is already registered.`);
    }

    // Runtime check: the registry calls `inputSchema.safeParse(...)` when
    // executing the tool, which is Zod-specific. A tool registered with a
    // plain JSONSchema object (or anything that lacks `.safeParse`) would
    // otherwise crash with a `TypeError: ... .safeParse is not a function`
    // at first execution — far from the registration site and hard to
    // diagnose. Failing fast at registration time produces a clear error
    // pointing at the offending tool name.
    //
    // The type system now enforces `.safeParse()` via `ZodSchemaLike`, but
    // this runtime guard is the final safety net: it catches cases where
    // `as any` casts bypass the type check.
    if (
      !definition.inputSchema ||
      typeof definition.inputSchema.safeParse !== "function"
    ) {
      throw new Error(
        `Tool '${definition.name}' has an invalid inputSchema: ` +
        `expected a Zod schema (or anything exposing a .safeParse() method), ` +
        `got ${typeof definition.inputSchema}.`
      );
    }

    if (!definition.riskLevel || !VALID_RISK_LEVELS.includes(definition.riskLevel)) {
      throw new Error(
        `Tool '${definition.name}' has an invalid riskLevel: '${String(definition.riskLevel)}'. ` +
        `Must be one of: ${VALID_RISK_LEVELS.join(", ")}.`
      );
    }

    // Runtime check: the handler is invoked as `definition.handler(...)` at
    // execution time. A definition without one was accepted at registration
    // and only failed at first call, with a raw
    // "definition.handler is not a function" TypeError — far from the
    // registration site and impossible to diagnose from the stack trace.
    // The same "fail fast at registration" argument this file already makes
    // for `inputSchema` applies here.
    if (typeof definition.handler !== "function") {
      throw new Error(
        `Tool '${definition.name}' must declare a handler function. ` +
        `Got ${typeof definition.handler}.`
      );
    }

    // The per-tool middlewares are composed into the pipeline the same way.
    middlewares.forEach((middleware, index) => {
      if (typeof middleware !== "function") {
        throw new Error(
          `Tool '${definition.name}' middleware #${index} is not a function. ` +
          `Got ${typeof middleware}.`
        );
      }
    });

    ToolRegistry.validateInputSchemaShape(definition.name, definition.inputSchema);
    ToolRegistry.rejectEnvelopeKeyCollision(definition.name, definition.inputSchema);

    this.tools.set(definition.name, {
      definition,
      middlewares,
    });
    this.pipelineCache.delete(definition.name);
  }

  /**
   * Reject a tool whose input schema declares one of the ENVELOPE keys.
   *
   * `idempotencyKey` and `confirmation` are handled by the FRAMEWORK: they
   * are promoted out of the raw arguments into the tool context and STRIPPED
   * from the input before validation. A tool that declares either name would
   * therefore never receive its own field — the value was silently removed
   * before the schema saw it (or, for a required field, the tool failed
   * validation with a misleading "Required" issue). There was no error at
   * registration and no error at runtime.
   *
   * The check is done on the schema's declared shape (Zod exposes `shape` for
   * object schemas). A schema without a `shape` (a custom Zod-like
   * implementation) cannot be inspected, so it is accepted — the strip is
   * then still harmless for tools that do not use those names.
   */
  private static rejectEnvelopeKeyCollision(toolName: string, schema: unknown): void {
    const shape = (schema as { shape?: unknown }).shape;
    if (shape == null || typeof shape !== "object") return;
    const declared = Object.keys(shape as Record<string, unknown>);
    for (const envelopeKey of ENVELOPE_KEYS) {
      if (declared.includes(envelopeKey)) {
        throw new Error(
          `Tool '${toolName}' must not declare '${envelopeKey}' in its input schema. ` +
          `The framework handles '${envelopeKey}' itself: it is promoted out of the tool arguments ` +
          `and stripped before validation, so the tool would never receive it.`
        );
      }
    }
  }

  /**
   * Get a registered tool by name.
   */
  get(name: string): RegistryEntry | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all registered tool names.
   */
  get names(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Execute a tool by name, running the full middleware pipeline.
   *
   * The pipeline is:
   *   global middlewares → tool middlewares → handler
   *
   * Each middleware wraps the next, so execution is:
   *   global[0](global[1](...tool[0](tool[1](handler))))
   */
  async execute(name: string, rawInput: unknown, context: ToolContext): Promise<ToolResult> {
    // Guard the tool name BEFORE anything else touches it. `name` is typed
    // `string`, but this is an exported entry point and the value can come
    // from a caller that does not honour the type. Without this guard the
    // name reached `findSimilarNames()` → `name.toLowerCase()` and threw a
    // raw `TypeError: name.toLowerCase is not a function` — which escapes
    // `execute()` entirely, because the errorHandlerMiddleware sits INSIDE
    // the pipeline and can only convert errors raised by a middleware or the
    // handler. The agent got an unstructured HTTP 500 instead of the
    // structured UNKNOWN_TOOL result every other bad-name path produces.
    if (typeof name !== "string") {
      return {
        success: false,
        error: {
          code: UNKNOWN_TOOL,
          message: "A tool name must be a string.",
          suggestedTools: ["list_available_tools"],
          context: { received: name === null ? "null" : typeof name },
        },
      };
    }

    // Auth-boundary guard: `context.tenantId` / `context.userId` are the values
    // used to scope idempotency records, tag the durable `ai_action_log` row,
    // and (inside handlers) set the RLS tenant context via `withTenant(...)`.
    // Nothing else in the mcp-tools pipeline validated them, so a server that
    // constructed `ToolContext` with an unvalidated / attacker-controlled
    // tenantId could set an arbitrary tenant on RLS — a cross-tenant access
    // path. Validate here, BEFORE any middleware or handler runs, and fail
    // closed with a non-enumerating error (no tenant/id echoed to the agent).
    const auth = ToolRegistry.validateContextIdentity(context);
    if ("error" in auth) {
      // A pre-pipeline rejection, like the unknown-tool and the
      // idempotency-key-conflict rejections below, is invisible in the
      // durable trail unless it is routed through the auditor explicitly.
      //
      // It is attributed to the TENANT only when the tenant id is valid: the
      // audit row is tenant-scoped (RLS) and there is no tenant to write it
      // under when the tenant id itself is the thing that failed. A valid
      // tenant with a hostile user/agent/conversation id is still worth
      // recording — it is an attack signal.
      this.auditIdentityRejection(name, context, auth);
      return auth.error;
    }

    const entry = this.tools.get(name);
    if (!entry) {
      // Hallucination guard — suggest similar tool names
      const similar = this.findSimilarNames(name);
      // Sanitize the requested tool name before reflecting it back to the agent:
      // `name` is attacker-controlled (the requested tool) and this result
      // bypasses errorHandlerMiddleware, so a crafted name embedding a secret
      // (e.g. `foo?api_key=sk_live_abc`) would otherwise reach the agent
      // unsanitized.
      //
      // The message and the context are ALSO capped at MAX_ERROR_MESSAGE_LENGTH.
      // `sanitizeForLogOutput` only truncates at its own 100 KB internal
      // guard, so an uncapped 120 KB tool name produced a 100 KB agent-facing
      // response — 50x the documented bound that every other agent-facing
      // error surface honours. The cap is applied AFTER sanitization, so the
      // secret-redaction pass sees the whole value, and it is applied to the
      // ASSEMBLED message (not just the name) so the wrapper text cannot
      // push the result back over the bound.
      const safeName = sanitizeForLogOutput(name);
      const safeSimilar = similar.map((s) => sanitizeForLogOutput(s));
      const message =
        `Tool '${safeName}' does not exist.${safeSimilar.length > 0 ? ` Similar tools: [${safeSimilar.map((s) => `'${s}'`).join(", ")}].` : ""} ` +
        `Use 'list_available_tools' to see all available tools.`;
      // The pipeline is composed PER TOOL, so this rejection never reaches
      // the audit middleware itself. It is therefore recorded explicitly
      // through the rejection auditor below — the identity IS validated at
      // this point (the auth-boundary guard above ran first), so the attempt
      // can and must be attributed instead of being invisible in the durable
      // trail.
      this.auditRejection({
        toolName: safeName,
        context,
        code: UNKNOWN_TOOL,
        message,
        input: rawInput,
      });
      return {
        success: false,
        error: {
          code: UNKNOWN_TOOL,
          message: capAgentErrorText(message),
          suggestedTools: ["list_available_tools", ...safeSimilar],
          context: { requestedTool: capAgentErrorText(safeName), similarTools: safeSimilar },
        },
      };
    }

    const { definition, middlewares } = entry;

    // Promote idempotency key from raw input into context so the
    // idempotency middleware can see it. Tool schemas validate the key,
    // but the middleware reads from context — not from parsed input.
    // Runtime guard: only treat non-null objects as potential sources;
    // primitives (number, string, boolean) cannot have an idempotencyKey.
    //
    // Fail closed: promote ANY present key (including empty, over-length,
    // or non-string values such as a numeric `12345`) so the idempotency
    // middleware — which validates the key as `unknown` and returns
    // INVALID_IDEMPOTENCY_KEY for empty/over-length/unsafe/NON-STRING
    // values — can reject it. Silently dropping an out-of-contract key here
    // would disable idempotency protection for that call (a retry could
    // duplicate a write) with no error, contradicting the middleware's
    // fail-closed contract. The previous string-only typeof gate meant an
    // agent passing a numeric/boolean/object key got its envelope silently
    // stripped below and the write executed unprotected.
    const raw = (rawInput != null && typeof rawInput === "object" && !Array.isArray(rawInput))
      ? rawInput as Record<string, unknown>
      : null;

    // Promote the envelope keys and detect conflicting idempotency keys.
    const promotion = ToolRegistry.promoteEnvelopeKeys(auth.context, raw);
    if ("error" in promotion) {
      // Same as the unknown-tool rejection: this happens BEFORE the pipeline
      // is composed, so the audit middleware never sees it — but the identity
      // is validated, so the attempt can and must be attributed.
      this.auditRejection({
        toolName: name,
        context: auth.context,
        code: promotion.error.error?.code ?? "INVALID_INPUT",
        message: promotion.error.error?.message ?? "The request was rejected before execution.",
        input: rawInput,
      });
      return promotion.error;
    }
    const effectiveContext = promotion.context;

    // Strip the envelope keys ONCE, BEFORE any middleware runs.
    //
    // The idempotency middleware computes its input hash via
    // `definition.inputSchema.safeParse(input)`, and every tool schema is a
    // z.strictObject that REJECTS undeclared keys — so if the envelope were
    // still present here, safeParse would fail for every idempotent call,
    // the middleware would log "input failed Zod validation" and SKIP
    // deduplication entirely (verified by probe: two identical calls
    // with the same key both executed the handler; no record was ever
    // created). The same strictness made the confirmation gate a dead end:
    // it injected `confirmation` into the input, and the final Zod step
    // rejected every gated tool with "Unrecognized key(s) in object:
    // 'confirmation'", so the 7 seeded high-risk tools could never execute
    // and their idempotency protection was silently disabled.
    //
    // Stripping here guarantees every middleware AND the final Zod
    // validation step see schema-conformant input. The final handler's own
    // strip remains as belt-and-suspenders in case a pipeline is invoked
    // through a path that bypasses execute().
    //
    // `rawInput` — NOT the `raw` object above — is what gets stripped.
    // `raw` is null for every NON-OBJECT input (an array, a string, a
    // number), and `stripEnvelopeKeys` is documented to pass non-objects
    // through untouched. Passing `raw` therefore REPLACED the caller's input
    // with `null` before validation, so a tool whose schema is not an
    // object (an array / union / scalar schema) was uncallable and the
    // agent got a misleading "expected array, received null" instead of an
    // error about its actual input.
    const pipelineInput = ToolRegistry.stripEnvelopeKeys(rawInput);

    // Check pipeline cache — rebuilt only on register() or addGlobalMiddleware()
    let pipeline = this.pipelineCache.get(name);
    if (!pipeline) {
      // Build the pipeline: handler is the innermost function
      const allMiddlewares = [...this.globalMiddlewares, ...middlewares];

      // Compose middlewares into a single function
      pipeline = allMiddlewares.reduceRight<
        (input: unknown, ctx: ToolContext) => Promise<ToolResult>
      >(
        (next, middleware) => {
          return (input, ctx) => middleware(input, ctx, definition, next);
        },
        // Final handler — validates input with Zod, then calls the handler
        async (input, ctx) => {
          const parsed = definition.inputSchema.safeParse(ToolRegistry.stripEnvelopeKeys(input));
          if (!parsed.success) {
            const issueString = parsed.error.issues
              .map((i) => `${i.path.map((p) => String(p)).join(".")}: ${i.message}`)
              .join("; ");
            const detailRaw = issueString.length > MAX_ERROR_MESSAGE_LENGTH
              ? `${truncateAtCharacterBoundary(issueString, MAX_ERROR_MESSAGE_LENGTH)}… [${parsed.error.issues.length} issues, truncated]`
              : issueString;
            // Sanitize the joined summary BEFORE embedding it in the agent-facing
            // `message`. `detailRaw` is only length-capped above; a Zod issue's
            // `message` can embed the received input (a custom errorMap echoing
            // `${input}`, or a schema that reports the offending value) so a
            // connection string / `?api_key=…` / ANSI-CRLF payload survives
            // verbatim — while the parallel `context.issues` array below IS
            // scrubbed via `sanitizeIssues`. That asymmetry is exactly the
            // secret-leak class rounds 42/44/48/49 closed on every other
            // surface; the errorHandlerMiddleware only catches *thrown* errors,
            // and this soft-failure return is never thrown, so it reaches the
            // agent unsanitized unless we scrub it here (verified: a crafted
            // `.refine()` message with `api_key=sk_live_abc` leaked the key in
            // `error.message` while `context.issues` redacted it).
            const detail = sanitizeForLogOutput(detailRaw);
            // The joined `message` is already capped AND sanitized above, but the
            // `context.issues` array is returned verbatim to the AI agent and
            // is NOT filtered through the error-handler's
            // `sanitizeContextValue` (that only runs on thrown DomainErrors).
            // A Zod issue's `message` can embed the received input (e.g. a
            // custom errorMap echoing `${input}`, or a tool whose schema
            // reports the offending value), and an issue whose `path` ends in a
            // sensitive-named key (password, apiKey, token, …) would surface
            // the rejected value to the agent — bypassing the field-name
            // redaction applied to live results and DomainError.context.
            // Sanitize every string (strip URLs/paths/ANSI) and redact values
            // carried under a sensitive-named path so this agent-facing surface
            // stays consistent with every other error path.
            const sanitizedIssues = ToolRegistry.sanitizeIssues(parsed.error.issues, MAX_VALIDATION_ISSUES);
            return sanitizeAgentFacingResult({
              success: false,
              error: {
                code: "INVALID_INPUT",
                message: `Input validation failed: ${detail}`,
                suggestedTools: [name],
                context: { issues: sanitizedIssues },
              },
            });
          }
          // The agent-facing boundary: EVERY value the agent sees goes
          // through the canonical redaction here, so it cannot depend on
          // which middlewares happen to be composed. Previously the
          // agent-facing redaction lived in the AUDIT middleware, which
          // meant a soft failure returned by the handler (the normal
          // business-rule path) had its `error.context` reflected VERBATIM
          // — while the identical value was redacted in the durable audit
          // row, the idempotency record and the thrown-error path.
          return sanitizeAgentFacingResult(await definition.handler(parsed.data, ctx));
        }
      );
      this.pipelineCache.set(name, pipeline);
    }

    return pipeline(pipelineInput, effectiveContext);
  }

  /**
   * Remove the envelope keys from raw input before schema validation.
   *
   * execute() promotes `idempotencyKey` and `confirmation` into the context
   * (which the idempotency middleware and the confirmation gate read — they
   * never read the input fields), and tool input schemas deliberately do not
   * declare them. Strict tool schemas (z.strictObject, matching REST
   * ValidationPipe's forbidNonWhitelisted posture) reject undeclared keys,
   * so the envelope must be stripped first or every idempotent/gated call
   * would fail validation.
   *
   * Called from TWO places by design:
   * - `execute()` strips before the PIPELINE runs, because the idempotency
   *   middleware hashes the raw input mid-pipeline (before the final Zod
   *   step) — see the probe-verified regression note there.
   * - The final handler strips again as defense-in-depth so a pipeline
   *   composed/invoked outside execute() cannot feed the envelope to Zod.
   *
   * Accepts `unknown`; non-object inputs pass through untouched.
   */
  private static stripEnvelopeKeys(input: unknown): unknown {
    if (input == null || typeof input !== "object" || Array.isArray(input)) return input;
    if (!("idempotencyKey" in input) && !("confirmation" in input)) return input;
    const {
      idempotencyKey: _promotedKey,
      confirmation: _promotedConfirmation,
      ...rest
    } = input as Record<string, unknown>;
    return rest;
  }

  /**
   * Promote the envelope keys from the raw tool arguments into the context,
   * and reject conflicting idempotency keys.
   *
   * Tool schemas deliberately do not declare `idempotencyKey` or
   * `confirmation` (see {@link stripEnvelopeKeys}), so the middleware
   * pipeline reads them from the context — never from the parsed input.
   *
   * Precedence:
   * - `idempotencyKey`: the context value wins (it is the dedup identity).
   *   When the caller supplies TWO different keys — one in the context and
   *   one in the tool arguments — the call FAILS CLOSED with
   *   IDEMPOTENCY_KEY_MISMATCH. The previous implementation silently
   *   preferred the context key and discarded the argument key, so the agent
   *   believed it deduplicated under one key while the durable idempotency
   *   record was keyed by the other.
   * - `confirmation`: the tool-argument value wins — it is the agent's
   *   per-call justification and it is what the confirmation gate validates.
   *   A context-provided confirmation is only a fallback for callers that do
   *   not pass one in the arguments.
   */
  private static promoteEnvelopeKeys(
    context: ToolContext,
    raw: Record<string, unknown> | null,
  ): { error: ToolResult } | { context: ToolContext } {
    // ONE definition of "the context carries a key". The conflict check and
    // the promotion used two different tests — `context.idempotencyKey !=
    // null` for the conflict and `!context.idempotencyKey` for the promotion
    // — so an EMPTY-STRING context key was simultaneously "present" (for the
    // conflict check) and "absent" (for the promotion). The result was a hard
    // IDEMPOTENCY_KEY_MISMATCH for a context key that the promotion branch
    // was written to treat as "no key at all". The idempotency middleware
    // itself treats "" as a pass-through no-op, so "" must mean "no key"
    // everywhere.
    //
    // A NON-STRING context key (a hand-constructed `ToolContext` with
    // `idempotencyKey: 12345`) counts as PRESENT: the old test required a
    // string, so such a key was treated as "no key at all" — the conflict
    // check was skipped and the ARGUMENT key silently replaced it, inverting
    // the documented precedence ("the context value wins — it is the dedup
    // identity"). The agent then deduplicated under a key it did not choose.
    // Keeping the context key means the idempotency middleware rejects it
    // with INVALID_IDEMPOTENCY_KEY, which is the fail-closed answer.
    const hasContextKey = context.idempotencyKey !== undefined
      && context.idempotencyKey !== null
      && context.idempotencyKey !== "";

    if (raw?.idempotencyKey != null && hasContextKey
      && raw.idempotencyKey !== context.idempotencyKey) {
      return {
        error: {
          success: false,
          error: {
            code: IDEMPOTENCY_KEY_MISMATCH,
            message: "Two different idempotency keys were supplied (one in the request context, one in the tool arguments). Use a single idempotency key.",
            suggestedTools: ["list_available_tools"],
          },
        },
      };
    }
    return {
      context: {
        ...context,
        ...(raw?.idempotencyKey != null && !hasContextKey
          ? { idempotencyKey: raw.idempotencyKey as string }
          : {}),
        ...(raw?.confirmation != null
          ? { confirmation: raw.confirmation as string }
          : {}),
      },
    };
  }

  /**
   * Validate the identity fields of a tool-execution context at the
   * auth boundary. `tenantId` and `userId` are used to scope idempotency
   * records, tag the durable audit row, and (inside handlers) set the RLS
   * tenant context — so an unvalidated value here is a cross-tenant access
   * path. Returns `{ error }` when either is malformed, or `{ context }`
   * carrying the NORMALIZED (trimmed) identity fields — the trimmed values
   * must propagate because handlers' RLS path trims via withTenant, while
   * the idempotency composite key and audit rows use the context verbatim;
   * propagating the untrimmed context keyed the idempotency record under a
   * different tenant string than the query executed under, so a correctly
   * trimmed retry missed the record and re-executed the write. Fails closed:
   * no tenant/id value is reflected to the agent on error.
   */
  private static validateContextIdentity(context: ToolContext):
    { error: ToolResult; rejection: { code: string; field: string } } | { context: ToolContext } {
    let tenantId: string;
    try {
      tenantId = validateTenantIdEnhancedForAuth(context.tenantId);
    } catch {
      return {
        error: ToolRegistry.contextIdentityError(INVALID_TENANT_ID, "tenant identifier"),
        rejection: { code: INVALID_TENANT_ID, field: "tenant identifier" },
      };
    }
    if (typeof context.userId !== "string") {
      return {
        error: ToolRegistry.contextIdentityError(INVALID_USER_ID, "user identifier"),
        rejection: { code: INVALID_USER_ID, field: "user identifier" },
      };
    }
    // Trim userId to match the behavior of McpService.buildContext and
    // TenantGuard — both accept whitespace-padded values by trimming them.
    // Reject only after trimming so a whitespace-only value is caught by
    // the length/pattern checks below, not by the trim-equality guard.
    const userId = context.userId.trim();
    if (userId.length === 0 || userId.length > MAX_USER_ID_LENGTH || !isValidOptionalId(userId)) {
      return {
        error: ToolRegistry.contextIdentityError(INVALID_USER_ID, "user identifier"),
        rejection: { code: INVALID_USER_ID, field: "user identifier" },
      };
    }
    // The identity must be STORABLE in the durable sinks, and the stored
    // value must be INJECTIVE.
    //
    // The stored identity is what the idempotency middleware COMPARES to
    // decide whether a record belongs to the same caller, and the plain
    // sanitizer is LOSSY for secret-shaped values: every one of them
    // collapses to the same placeholder, so two DIFFERENT callers became
    // indistinguishable — the second one received the first one's stored
    // result as a `replayed` success (a cross-user disclosure), and the
    // audit trail could not attribute the action to a principal.
    //
    // `sanitizeDurableIdentity` (the shared durable-sink sanitizer) fixes
    // that by appending a digest of the RAW identity whenever the redaction
    // changed the value. The check here only asserts that the value is
    // storable at all.
    if (sanitizeDurableIdentity(userId, MAX_USER_ID_LENGTH) === null) {
      return {
        error: ToolRegistry.contextIdentityError(INVALID_USER_ID, "user identifier"),
        rejection: { code: INVALID_USER_ID, field: "user identifier" },
      };
    }
    // `agentId`/`conversationId` are persisted verbatim into the cross-tenant
    // durable idempotency + audit sinks, so an unvalidated/oversized/attacker-
    // controlled value would bloat those rows and bypass the validation that
    // tenantId/userId receive. They are optional, but when present they must
    // match the same character/length contract as the other identity fields.
    // Validate agentId first; if it is absent or valid, fall through to
    // conversationId. Using explicit `if` / `else` instead of `??` makes the
    // short-circuit semantics obvious and avoids the cognitive load of
    // reading `??` as "if-null-then-try-the-next-field".
    const agentIdError = ToolRegistry.validateOptionalIdentityField(context.agentId, "agentId", MAX_AGENT_ID_LENGTH);
    if (agentIdError) {
      return { error: agentIdError, rejection: { code: INVALID_CONTEXT_ID, field: "agentId" } };
    }
    const conversationIdError = ToolRegistry.validateOptionalIdentityField(context.conversationId, "conversationId", MAX_CONVERSATION_ID_LENGTH);
    if (conversationIdError) {
      return { error: conversationIdError, rejection: { code: INVALID_CONTEXT_ID, field: "conversationId" } };
    }
    const agentId = ToolRegistry.normalizedOptionalIdentityField(context.agentId);
    const conversationId = ToolRegistry.normalizedOptionalIdentityField(context.conversationId);
    // Only rebuild the context when a value actually changed — avoids
    // needless object churn (and a new reference) on the common path.
    const identityChanged = tenantId !== context.tenantId || userId !== context.userId
      || agentId !== context.agentId || conversationId !== context.conversationId;
    return { context: identityChanged ? { ...context, tenantId, userId, agentId, conversationId } : context };
  }

  private static contextIdentityError(code: string, fieldLabel: string): ToolResult {
    return {
      success: false,
      error: {
        code,
        message: `The request ${fieldLabel} is invalid. Contact the system administrator.`,
        suggestedTools: ["list_available_tools"],
      },
    };
  }

  /**
   * Validate an optional agent/conversation identity field against the same
   * character set and length bounds as tenantId/userId. Returns a failing
   * ToolResult when malformed, or null when absent/acceptable.
   */
  private static validateOptionalIdentityField(
    value: string | undefined,
    field: string,
    maxLength: number,
  ): ToolResult | null {
    // Treat null as absent — mirrors JwtStrategy.validateOptionalField and
    // McpService's validateOptionalString (both used upstream of this
    // boundary), so an explicit null never reaches the trim/validate path
    // below (where it would throw) nor the strict string check.
    if (value === undefined || value === null) return null;
    // Type-check BEFORE trim: a direct JS caller constructing a ToolContext
    // with a non-string agentId/conversationId (e.g. a number) would throw a
    // raw TypeError on .trim() below. This method runs inside execute()
    // BEFORE any middleware is composed, so nothing would catch that throw —
    // it would propagate out of the registry as an unhandled exception
    // instead of the structured INVALID_CONTEXT_ID result. (The previous
    // typeof check sat AFTER .trim(), making it unreachable for exactly the
    // non-string values it was written to guard.)
    if (typeof value !== "string") {
      return {
        success: false,
        error: {
          code: INVALID_CONTEXT_ID,
          message: `The ${field} is invalid. Contact the system administrator.`,
          suggestedTools: ["list_available_tools"],
        },
      };
    }
    // Trim before validating — userId above is accepted-after-trim, so
    // rejecting " agent-1" here while accepting " user-1" above was an
    // inconsistency between identity fields of the same shape. Whitespace-only
    // values fall through to the length check and are rejected.
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > maxLength || !isValidOptionalId(trimmed)) {
      return {
        success: false,
        error: {
          code: INVALID_CONTEXT_ID,
          message: `The ${field} is invalid. Contact the system administrator.`,
          suggestedTools: ["list_available_tools"],
        },
      };
    }
    // Same storability requirement as userId — see the note there.
    if (sanitizeDurableIdentity(trimmed, maxLength) === null) {
      return {
        success: false,
        error: {
          code: INVALID_CONTEXT_ID,
          message: `The ${field} is invalid. Contact the system administrator.`,
          suggestedTools: ["list_available_tools"],
        },
      };
    }
    return null;
  }

  /**
   * Trim an optional agent/conversation identity field. Returns the trimmed
   * value, or undefined when absent. Paired with validateOptionalIdentityField
   * (which validates the trimmed form) so the values persisted into the
   * durable idempotency + audit sinks match the values that were validated —
   * the same trimmed-values-must-propagate contract tenantId/userId follow.
   */
  private static normalizedOptionalIdentityField(value: string | undefined): string | undefined {
    // Null is treated as absent by validateOptionalIdentityField (matching
    // JwtStrategy/McpService), so it must be normalized away here too rather
    // than crashing on .trim().
    return value == null ? undefined : value.trim();
  }

  /**
   * Generate discovery information for all registered tools.
   * Used by the `list_available_tools` discovery tool.
   */
  getDiscoveryInfo(): Array<{
    name: string;
    description: string;
    riskLevel: string;
    entity?: string;
    tags?: string[];
  }> {
    return Array.from(this.tools.values()).map((entry) => ({
      name: entry.definition.name,
      // Return the full description (including multi-line content) so agents
      // using discovery see the complete documentation, not just the first
      // line. The tool's input schema carries the full description via
      // entry.definition.description, so the discovery surface should not
      // artificially truncate it — that information is available to agents
      // that read the full schema but would be lost on a bare discovery pass.
      description: entry.definition.description,
      riskLevel: entry.definition.riskLevel,
      entity: entry.definition.entity,
      tags: entry.definition.tags ? [...entry.definition.tags] : undefined,
    }));
  }

  /**
   * Second-level runtime guard: verify the safeParse result shape matches
   * what the registry expects. Some Zod-compatible libraries expose
   * `.safeParse()` but return a different error shape (e.g. Zod v4 wraps
   * issues under `.issues` instead of a top-level `issues` array). This
   * is extracted from {@link register} to keep that method's cyclomatic
   * complexity within the lint cap while still catching shape mismatches
   * at registration time rather than mid-execution.
   */
  private static validateInputSchemaShape(toolName: string, schema: unknown): void {
    const cast = schema as { safeParse: (i: unknown) => { success: boolean; data?: unknown; error?: { issues?: unknown } } };
    if (typeof cast.safeParse !== "function") return;
    // Probe with a definitely-invalid input so the error shape is always
    // exercised regardless of whether the schema accepts undefined. Probing
    // with undefined would short-circuit the guard when the schema declares
    // undefined valid (success:true), leaving shape mismatches undetected.
    const probe = cast.safeParse({ __mcp_tools_shape_probe__: true });
    // Validate the error shape whenever the probe produces an error — a
    // schema that accepts the probe input (success:true) has no error shape
    // to check here, but a second probe below may produce one.
    if (probe.error) {
      ToolRegistry.assertErrorShape(toolName, probe.error);
    }
    // Second probe with null: catches schemas that accept arbitrary objects
    // (e.g. z.any(), z.record(), or custom schemas) but reject scalars.
    // Without this, a schema that passes the object probe would skip shape
    // validation entirely, and a real runtime validation failure would
    // produce an error without .issues — later crashing at
    // parsed.error.issues.map(...) with a TypeError. `typeof null === "object"`
    // in JavaScript, so the null guard inside assertErrorShape is required.
    const probeNull = cast.safeParse(null);
    if (probeNull.error) {
      ToolRegistry.assertErrorShape(toolName, probeNull.error);
    }
  }

  /** Assert that an error object from safeParse() carries an 'issues' array.
   *  Extracted from validateInputSchemaShape to keep that method's complexity
   *  within the lint cap while still validating the shape on both probes. */
  private static assertErrorShape(toolName: string, error: unknown): void {
    // `typeof null === "object"` in JavaScript, so an explicit null guard is
    // required here: a schema whose error shape carries `issues: null` would
    // otherwise pass the type check and later crash at `parsed.error.issues.map(...)`
    // when a real validation error fires. The null check keeps the guard accurate.
    const errorShape = error as Record<string, unknown>;
    if (errorShape.issues == null || typeof errorShape.issues !== "object" || !Array.isArray(errorShape.issues)) {
      throw new Error(
        `Tool '${toolName}': inputSchema.safeParse() returned an error without an 'issues' array. ` +
        `Expected { success: false, error: { issues: [...] } }; got a shape that may be incompatible with this registry.`
      );
    }
  }

  /**
   * Find tool names that are similar to a given (possibly hallucinated) name.
   * Uses simple string similarity — good enough for common hallucinations.
   */
  private findSimilarNames(name: string): string[] {
    const lowerName = name.toLowerCase();
    if (lowerName.length < 2) return [];
    return Array.from(this.tools.keys())
      .filter((existing) => {
        const lower = existing.toLowerCase();
        // Substring match (minimum 2 chars to reduce false positives)
        if (lower.includes(lowerName) || lowerName.includes(lower)) return true;
        // Check Levenshtein-like: shared word stems. Guard BOTH directions
        // with the >=2-char minimum the substring match above documents —
        // previously only `ep.includes(p)` was guarded, so a 1-char part
        // (e.g. "a" from "add_a") matched any existing part containing it.
        const nameParts = lowerName.split(/[_\s]+/).filter((p) => p.length >= 2);
        const existingParts = lower.split(/[_\s]+/).filter((p) => p.length >= 2);
        return nameParts.length > 0 && existingParts.length > 0 &&
          nameParts.some((p) => existingParts.some((ep) => ep.includes(p) || p.includes(ep)));
      })
      .slice(0, 5);
  }

  /**
   * Sanitize and redact Zod validation issues before returning them to the
   * AI agent in `context.issues`. Mirrors the redaction (sensitive-named
   * paths) and log-output sanitization (URLs/paths/ANSI) applied by
   * `redactSensitiveFields` / `sanitizeContextValue` to every other
   * agent-facing surface, so a failed-validation response cannot leak a
   * secret carried under a sensitive-named field or an embedded connection
   * string. Caps to the first `maxIssues` issues for memory safety.
   *
   * Each issue's `message` and `received` are length-capped INDEPENDENTLY of
   * the issue count: a Zod issue message can echo the offending input
   * verbatim (a custom `errorMap` that interpolates the value), so without a
   * per-issue cap the bounded issue array could still carry ~50 × 100 KB to
   * the agent — the aggregate was bounded but the payload was not.
   */
  private static sanitizeIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string; code?: string; received?: unknown }>, maxIssues: number): unknown[] {
    return issues.slice(0, maxIssues).map((issue) => {
      const path = issue.path.map((p) => String(p));
      // Path KEY NAMES are deliberately preserved (only control/URL content is
      // scrubbed): the agent needs the real field path to fix its input, and a
      // key name like "password" is metadata, not a secret. The VALUE carried
      // under a sensitive-named path is redacted via `received` below.
      const sanitizedPath = path.map((p) => sanitizeForLogOutput(p));
      const redacted: Record<string, unknown> = {
        // The field is named `issueCode`, NOT `code`: `code` is a SENSITIVE
        // field name (it is where a one-time code / OTP usually lives), so
        // the agent-facing context redaction would replace the issue type
        // with "[REDACTED]" and the agent would lose the information it
        // needs to fix its input.
        issueCode: sanitizeForLogOutput(String(issue.code ?? "custom")),
        // A Zod issue message can echo the offending input verbatim (e.g.
        // "Expected string, received {raw password}"), so run it through the
        // deep redactor as well as the length/char sanitizer.
        message: ToolRegistry.capIssueText(redactSensitiveFieldValues(issue.message)),
        path: sanitizedPath,
      };
      const sensitivePathSegments = path.filter((p) => isSensitiveFieldName(p));
      const lastSegment = path.length > 0 ? path[path.length - 1]! : "";
      // Only include `received` when Zod actually supplied one — a missing-
      // value issue (e.g. invalid_type with received: undefined) on a
      // sensitive path previously got a fabricated received: "[REDACTED]",
      // telling the agent a value was supplied when none was.
      const hasReceived = issue.received !== undefined;
      if (hasReceived && (sensitivePathSegments.length > 0 || isSensitiveFieldName(lastSegment))) {
        redacted.received = "[REDACTED]";
      } else if (hasReceived) {
        redacted.received = ToolRegistry.capIssueText(redactSensitiveFieldValues(issue.received));
      }
      return redacted;
    });
  }

  /**
   * Length-cap a redacted issue message / received value.
   *
   * Strings are truncated on a character boundary; non-string values are
   * serialised and truncated so a huge object cannot ride along inside the
   * bounded issue array.
   */
  private static capIssueText(value: unknown): unknown {
    if (typeof value === "string") {
      // Truncate on a CHARACTER boundary — `slice` counts UTF-16 code units,
      // so a cut between a high and a low surrogate produced a lone surrogate
      // in the agent-facing string.
      return value.length > MAX_VALIDATION_ISSUE_MESSAGE_LENGTH
        ? `${truncateAtCharacterBoundary(value, MAX_VALIDATION_ISSUE_MESSAGE_LENGTH)}…`
        : value;
    }
    if (value === null || value === undefined) return value;
    if (typeof value === "object") {
      try {
        const serialized = JSON.stringify(value);
        if (typeof serialized !== "string") return "[Unserializable]";
        return serialized.length > MAX_VALIDATION_ISSUE_MESSAGE_LENGTH
          ? `${truncateAtCharacterBoundary(serialized, MAX_VALIDATION_ISSUE_MESSAGE_LENGTH)}…`
          : serialized;
      } catch {
        return "[Unserializable]";
      }
    }
    return value;
  }
}

// NOTE: No singleton is exported. Create instances via `new ToolRegistry()`.
