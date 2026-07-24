// Sensitive-field detection — thin re-exports so audit-log.ts and
// error-handler.ts can import from a local module path without changing their
// import statements. The actual logic lives in @besterp/shared and is the
// single source of truth for what counts as sensitive.

export { splitFieldNameTokens as splitFieldTokens, isSensitiveFieldName as isSensitiveField } from "@besterp/shared";
