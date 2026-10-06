import test from "node:test";
import assert from "node:assert/strict";
import { extractCommand } from "../dist/command.js";

test("accepts a complete prefix with supported separators", () => {
  assert.equal(extractCommand("co тест", true, "co"), "тест");
  assert.equal(extractCommand("co: тест", true, "co"), "тест");
  assert.equal(extractCommand("co - тест", true, "co"), "тест");
});

test("does not accept a longer word that merely starts with the prefix", () => {
  assert.equal(extractCommand("cod тест", true, "co"), null);
  assert.equal(extractCommand("codex тест", true, "cod"), null);
});

test("returns all trimmed text when filtering is disabled", () => {
  assert.equal(extractCommand("  обычное сообщение  ", false, "co"), "обычное сообщение");
});

