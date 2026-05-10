import crypto from "crypto";

/**
 * Hash a tool input for idempotency mismatch detection.
 *
 * Produces a deterministic SHA-256 hash of the JSON-serialized input.
 * Used to detect when the same idempotency key is reused with different input.
 */
export function hashInput(input: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
}
