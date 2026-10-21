import assert from "node:assert/strict";
import test from "node:test";
import { retry } from "../src/retry.js";

test("retries until the operation succeeds", async () => {
  let calls = 0;
  const result = await retry(async () => {
    calls += 1;
    if (calls < 2) throw new Error("transient");
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 2);
});
