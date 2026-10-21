import assert from "node:assert/strict";
import test from "node:test";
import { LruCache } from "../src/cache.js";

test("stores and retrieves values", () => {
  const cache = new LruCache(2);
  cache.set("a", 1);
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.size, 1);
});
