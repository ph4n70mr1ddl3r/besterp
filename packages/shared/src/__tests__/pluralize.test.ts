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

  it("handles words ending in 'fe'", () => {
    expect(pluralize("knife")).toBe("knives");
    expect(pluralize("life")).toBe("lives");
  });

  it("handles words already ending in 'ves'", () => {
    expect(pluralize("knives")).toBe("knives");
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

  it("preserves original casing for the plural suffix", () => {
    expect(pluralize("Party")).toBe("Parties");
    expect(pluralize("Address")).toBe("Addresses");
  });
});
