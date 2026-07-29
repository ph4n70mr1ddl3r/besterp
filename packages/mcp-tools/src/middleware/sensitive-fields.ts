// Sensitive-field detection — thin re-exports so tool-registry.ts can import
// from a local module path. The actual logic lives in @besterp/shared and is
// the single source of truth for what counts as sensitive.

export { splitFieldNameTokens as splitFieldTokens, isSensitiveFieldName as isSensitiveField } from "@besterp/shared";
