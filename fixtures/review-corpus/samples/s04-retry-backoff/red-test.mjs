import assert from "node:assert/strict";
import { backoffMs } from "./src/retry.js";

assert.equal(backoffMs(0), 100, "first retry starts at the base delay");
assert.equal(backoffMs(1), 200);
assert.equal(backoffMs(10), 1_000, "delay must be capped");
console.log("s04 red test passed");
