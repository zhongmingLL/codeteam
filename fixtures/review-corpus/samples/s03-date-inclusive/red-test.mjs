import assert from "node:assert/strict";
import { eachDay } from "./src/date.js";

assert.deepEqual(eachDay("2024-03-09", "2024-03-10"), ["2024-03-09", "2024-03-10"]);
assert.deepEqual(
  eachDay("2024-03-09", "2024-03-11", { inclusive: false }),
  ["2024-03-09", "2024-03-10"],
  "exclusive end must not include the end date",
);
console.log("s03 red test passed");
