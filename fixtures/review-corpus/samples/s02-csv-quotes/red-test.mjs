import assert from "node:assert/strict";
import { parseLine } from "./src/csv.js";

assert.deepEqual(parseLine('"a,b",c'), ["a,b", "c"]);
assert.deepEqual(parseLine('"a""b",c'), ['a"b', "c"], "escaped quotes must round-trip");
console.log("s02 red test passed");
