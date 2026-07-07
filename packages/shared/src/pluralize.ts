// Simple English pluralization for entity names used in MCP error messages and suggested tool names.

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
};

export function pluralize(entity: string): string {
  const lower = entity.toLowerCase();
  if (IRREGULAR_PLURALS[lower]) return IRREGULAR_PLURALS[lower];
  if (lower.endsWith("y") && !lower.endsWith("ay") && !lower.endsWith("ey") && !lower.endsWith("oy") && !lower.endsWith("uy")) {
    return entity.slice(0, -1) + "ies";
  }
  if (lower.endsWith("fe")) {
    return entity.slice(0, -2) + "ves";
  }
  if (lower.endsWith("ves")) {
    return entity;
  }
  if (lower.endsWith("s") || lower.endsWith("x") || lower.endsWith("z") || lower.endsWith("ch") || lower.endsWith("sh")) {
    return entity + "es";
  }
  return entity + "s";
}
