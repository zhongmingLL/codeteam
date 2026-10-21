import assert from "node:assert/strict";
import { mode } from "./src/stats.js";

const values = [1, 2, 2, 3];
assert.equal(mode(values), 2, "mode must return the most frequent value");
assert.deepEqual(values, [1, 2, 2, 3], "mode must not mutate its input");
assert.equal(mode([3, 1, 3, 1]), 1, "ties must resolve to the smallest value");
console.log("s01 red test passed");
