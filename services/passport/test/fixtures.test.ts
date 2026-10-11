import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const LOCAL = fileURLToPath(new URL("./fixtures/hl/", import.meta.url));
const SOURCE = fileURLToPath(new URL("../../../docs/passport-fixtures/", import.meta.url));

const files = readdirSync(SOURCE).filter((f) => f.endsWith(".json")).sort();
const accounts = files.filter((f) => f !== "eip712_crosscheck.json");

describe("fixtures", () => {
  it("copies every docs/passport-fixtures file unchanged (re-copy if this fails)", () => {
    expect(readdirSync(LOCAL).filter((f) => f.endsWith(".json")).sort()).toEqual(files);
    for (const f of files) expect(readFileSync(LOCAL + f, "utf8")).toBe(readFileSync(SOURCE + f, "utf8"));
  });

  it.each(accounts)("%s carries capturedAtMs, address and expected result", (f) => {
    const fx = JSON.parse(readFileSync(LOCAL + f, "utf8"));
    expect(Number.isInteger(fx.capturedAtMs)).toBe(true);
    expect(fx.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(fx.expected).toBeTypeOf("object");
  });
});
