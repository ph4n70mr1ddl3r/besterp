import { describe, it, expect } from "vitest";
import { pluralize } from "../pluralize.js";

describe("pluralize", () => {
  it("appends 's' for regular words", () => {
    expect(pluralize("entity")).toBe("entities");
    expect(pluralize("test")).toBe("tests");
    expect(pluralize("party")).toBe("parties");
    expect(pluralize("address")).toBe("addresses");
  });

  it("handles words ending in 's', 'x', 'z', 'ch', 'sh'", () => {
    expect(pluralize("status")).toBe("statuses");
    expect(pluralize("box")).toBe("boxes");
    expect(pluralize("buzz")).toBe("buzzes");
    expect(pluralize("batch")).toBe("batches");
    expect(pluralize("dish")).toBe("dishes");
  });

  it("handles words ending in 'y'", () => {
    expect(pluralize("category")).toBe("categories");
    expect(pluralize("company")).toBe("companies");
  });

  it("preserves words ending in 'ay', 'ey', 'oy', 'uy'", () => {
    expect(pluralize("essay")).toBe("essays");
    expect(pluralize("monkey")).toBe("monkeys");
    expect(pluralize("boy")).toBe("boys");
    expect(pluralize("guy")).toBe("guys");
  });

  it("handles words ending in consonant + o", () => {
    expect(pluralize("potato")).toBe("potatoes");
    expect(pluralize("hero")).toBe("heroes");
    expect(pluralize("studio")).toBe("studios");
    expect(pluralize("patio")).toBe("patios");
  });

  it("handles words already ending in 'ves' (already plural form)", () => {
    // "knives" and "lives" are already plural forms — pluralizing a plural
    // is a no-op in practice. These words end in "ves" which is a sibilant
    // ending, so the regular rule would produce "kniveses"/"liveses". The
    // test documents that these edge cases (already-plural -ves words) are
    // not targeted by this codebase's pluralize usage (MCP error messages
    // only pluralize singular entity names like "party" → "parties").
    expect(pluralize("knives")).toBe("knives");
    expect(pluralize("lives")).toBe("lives");
    // Words ending in -ves that are NOT in the irregular list should also
    // pass through unchanged — the -ves short-circuit catches them before
    // the regular rule could double-pluralize (e.g. "waves" → "waves", not
    // "waveses"). The irregular list only covers a handful of canonical
    // cases; everything else ending in -ves is treated as already plural.
    expect(pluralize("waves")).toBe("waves");
    expect(pluralize("caves")).toBe("caves");
    expect(pluralize("doves")).toBe("doves");
  });

  it("handles irregular plurals", () => {
    expect(pluralize("child")).toBe("children");
    expect(pluralize("mouse")).toBe("mice");
    expect(pluralize("goose")).toBe("geese");
    expect(pluralize("man")).toBe("men");
    expect(pluralize("woman")).toBe("women");
    expect(pluralize("tooth")).toBe("teeth");
    expect(pluralize("foot")).toBe("feet");
    expect(pluralize("ox")).toBe("oxen");
    expect(pluralize("datum")).toBe("data");
    expect(pluralize("person")).toBe("people");
  });

  it("handles -f/-fe to -ves irregulars", () => {
    expect(pluralize("loaf")).toBe("loaves");
    expect(pluralize("wolf")).toBe("wolves");
    expect(pluralize("calf")).toBe("calves");
    expect(pluralize("half")).toBe("halves");
    expect(pluralize("leaf")).toBe("leaves");
    expect(pluralize("shelf")).toBe("shelves");
    expect(pluralize("thief")).toBe("thieves");
    expect(pluralize("self")).toBe("selves");
    expect(pluralize("elf")).toBe("elves");
    expect(pluralize("sheaf")).toBe("sheaves");
  });

  it("preserves original casing for the plural suffix", () => {
    expect(pluralize("Party")).toBe("Parties");
    expect(pluralize("Address")).toBe("Addresses");
  });

  it("preserves original casing for irregular plurals", () => {
    expect(pluralize("Person")).toBe("People");
    expect(pluralize("person")).toBe("people");
    expect(pluralize("PERSON")).toBe("PEOPLE");
    expect(pluralize("Child")).toBe("Children");
    expect(pluralize("child")).toBe("children");
  });

  it("preserves casing for single-letter input", () => {
    // Single uppercase letter must NOT be force-uppercased to all-caps.
    // "Y" is a consonant-y ending → "ies" suffix; the fix ensures it is not
    // expanded to "IES" (the previous all-caps branch behaviour). A lowercase
    // single letter remains unchanged in case.
    expect(pluralize("Y")).toBe("Ies");
    expect(pluralize("y")).toBe("ies");
  });

  it("handles non-letter first characters in preserveCasing", () => {
    // Non-letter characters like digits should not be treated as uppercase
    expect(pluralize("1st")).toBe("1sts");
    expect(pluralize("_test")).toBe("_tests");
  });

  it("returns empty string for empty input", () => {
    expect(pluralize("")).toBe("");
  });
});
