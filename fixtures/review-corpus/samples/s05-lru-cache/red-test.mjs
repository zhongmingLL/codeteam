import assert from "node:assert/strict";
import { LruCache } from "./src/cache.js";

const cache = new LruCache(2);
cache.set("a", 1);
cache.set("b", 2);
cache.set("a", 3);
cache.set("c", 4);
assert.equal(cache.get("a"), 3, "overwriting a key must refresh its recency");
assert.equal(cache.get("b"), undefined, "the least recently used key must be evicted");
console.log("s05 red test passed");
