export class LruCache {
  constructor(capacity = 10) {
    this.capacity = capacity;
    this.entries = new Map();
  }

  get(key) {
    return this.entries.get(key);
  }

  set(key, value) {
    this.entries.set(key, value);
  }

  get size() {
    return this.entries.size;
  }
}
