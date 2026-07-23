// Simple English pluralization for entity names used in MCP error messages and suggested tool names.
// Not a full grammar — handles the entity names this codebase uses.

const IRREGULAR_PLURALS: Record<string, string> = {
  child: "children",
  mouse: "mice",
  goose: "geese",
  man: "men",
  woman: "women",
  tooth: "teeth",
  foot: "feet",
  ox: "oxen",
  datum: "data",
  person: "people",
  knife: "knives",
  life: "lives",
  wife: "wives",
  loaf: "loaves",
  wolf: "wolves",
  calf: "calves",
  half: "halves",
  leaf: "leaves",
  shelf: "shelves",
  thief: "thieves",
  self: "selves",
  elf: "elves",
  sheaf: "sheaves",
};

function preserveCasing(input: string, plural: string): string {
  if (input.length === 0) return plural;
  // All-caps input (e.g. "PARTY") → all-caps plural. A single-character input
  // is excluded from this branch: "Y".toUpperCase() === "Y", so a lone
  // uppercase letter would otherwise be forced to all-caps and lose its
  // Title-case leading capital (e.g. "Y" → "IES" instead of "Yies"). The
  // single-character case falls through to the leading-capital rule below.
  if (input.length > 1 && input === input.toUpperCase()) return plural.toUpperCase();
  // First-letter-capitalized input (e.g. "Party", "Y") → Title-case plural.
  // A single-character input is excluded from the all-caps branch above,
  // so this condition is equivalent to `first === first.toUpperCase()`
  // for single chars. Using the explicit dual form avoids ambiguity.
  const first = input.charAt(0);
  if (first !== first.toLowerCase() && first === first.toUpperCase()) {
    return plural.charAt(0).toUpperCase() + plural.slice(1);
  }
  return plural;
}

const VOWELS = new Set(["a", "e", "i", "o", "u"]);

function isConsonantYEnding(lower: string): boolean {
  return lower.endsWith("y") && !lower.endsWith("ay") && !lower.endsWith("ey") && !lower.endsWith("oy") && !lower.endsWith("uy");
}

function isSibilantEnding(lower: string): boolean {
  return lower.endsWith("s") || lower.endsWith("x") || lower.endsWith("z") || lower.endsWith("ch") || lower.endsWith("sh");
}

function isConsonantOEnding(lower: string): boolean {
  return lower.endsWith("o") && lower.length >= 2 && !VOWELS.has(lower.charAt(lower.length - 2));
}

export function pluralize(entity: string): string {
  if (entity.length === 0) return entity;
  const lower = entity.toLowerCase();
  const irregular = IRREGULAR_PLURALS[lower];
  if (irregular) return preserveCasing(entity, irregular);
  if (isConsonantYEnding(lower)) return preserveCasing(entity, entity.slice(0, -1) + "ies");
  if (lower.endsWith("ves")) return entity;
  if (isSibilantEnding(lower)) return preserveCasing(entity, entity + "es");
  if (isConsonantOEnding(lower)) return preserveCasing(entity, entity + "es");
  return preserveCasing(entity, entity + "s");
}
