import { beforeEach, describe, expect, it } from "vitest";

import { ImageDimensionCache } from "../../src/webview/cm/image/image-dimension-cache.js";

describe("ImageDimensionCache", () => {
  let cache: ImageDimensionCache;
  beforeEach(() => {
    cache = new ImageDimensionCache(3);
  });

  it("returns undefined for an unknown key", () => {
    expect(cache.get("nope")).toBeUndefined();
  });

  it("stores and retrieves dimensions", () => {
    cache.set("a", { width: 10, height: 20 });
    expect(cache.get("a")).toEqual({ width: 10, height: 20 });
    expect(cache.size).toBe(1);
  });

  it("overwrites an existing key without growing size", () => {
    cache.set("a", { width: 1, height: 1 });
    cache.set("a", { width: 2, height: 2 });
    expect(cache.get("a")).toEqual({ width: 2, height: 2 });
    expect(cache.size).toBe(1);
  });

  it("evicts the least-recently-used entry past capacity", () => {
    cache.set("a", { width: 1, height: 1 });
    cache.set("b", { width: 2, height: 2 });
    cache.set("c", { width: 3, height: 3 });
    cache.set("d", { width: 4, height: 4 }); // evicts "a"
    expect(cache.size).toBe(3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toEqual({ width: 2, height: 2 });
    expect(cache.get("d")).toEqual({ width: 4, height: 4 });
  });

  it("get() promotes a key so it survives a later eviction (LRU, not FIFO)", () => {
    cache.set("a", { width: 1, height: 1 });
    cache.set("b", { width: 2, height: 2 });
    cache.set("c", { width: 3, height: 3 });
    expect(cache.get("a")).toEqual({ width: 1, height: 1 }); // touch "a" → now MRU
    cache.set("d", { width: 4, height: 4 }); // evicts LRU = "b", not "a"
    expect(cache.get("a")).toEqual({ width: 1, height: 1 });
    expect(cache.get("b")).toBeUndefined();
  });

  it("set() on an existing key promotes it to MRU (survives a later eviction)", () => {
    cache.set("a", { width: 1, height: 1 });
    cache.set("b", { width: 2, height: 2 });
    cache.set("c", { width: 3, height: 3 });
    cache.set("a", { width: 9, height: 9 }); // re-set "a" → now MRU
    cache.set("d", { width: 4, height: 4 }); // evicts LRU = "b", not "a"
    expect(cache.get("a")).toEqual({ width: 9, height: 9 });
    expect(cache.get("b")).toBeUndefined();
  });

  it("clear() empties the cache", () => {
    cache.set("a", { width: 1, height: 1 });
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });
});
