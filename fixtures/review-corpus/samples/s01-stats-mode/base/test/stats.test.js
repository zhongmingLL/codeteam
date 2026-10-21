import assert from "node:assert/strict";
import test from "node:test";
import { mean, median } from "../src/stats.js";

test("mean averages values", () => {
  assert.equal(mean([2, 4, 6]), 4);
});

test("median handles odd and even lengths", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});
