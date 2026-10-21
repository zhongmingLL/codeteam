import assert from "node:assert/strict";
import test from "node:test";
import { daysBetween } from "../src/date.js";

test("counts whole days between two dates", () => {
  assert.equal(daysBetween("2024-03-09", "2024-03-11"), 2);
});
