import assert from "node:assert/strict";
import test from "node:test";
import { parseLine } from "../src/csv.js";

test("splits simple fields", () => {
  assert.deepEqual(parseLine("a,b,c"), ["a", "b", "c"]);
});
