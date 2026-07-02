// Bounded-LRU cache of natural image dimensions, keyed by RESOLVED src URI
// (the webview-resource URL the widget actually loads — a stable,
// resource-addressed key). Purpose: when an image widget is (re)built —
// initial mount, host reseed, or a bounded recompute that moved/changed the
// widget's DOM — reading cached natural dimensions lets toDOM reserve space
// immediately so the loaded image does not reflow the document. Natural
// dimensions are recorded on the <img> `load` event. The Map preserves
// insertion order; delete-then-set moves a key to the most-recently-used end,
// and eviction drops from the least-recently-used front.
//
// Space reservation is BEST-EFFORT, not authoritative: if the file behind a
// path is swapped externally for one with different dimensions, the stale
// cached size is briefly applied on the next rebuild and then corrected by the
// fresh `load` event (which overwrites the entry). Acceptable — the
// alternative (no reservation) reflows on every rebuild.

export interface ImageDimensions {
  width: number;
  height: number;
}

export class ImageDimensionCache {
  readonly #map = new Map<string, ImageDimensions>();

  constructor(private readonly max: number) {}

  get(key: string): ImageDimensions | undefined {
    const value = this.#map.get(key);
    if (value !== undefined) {
      // LRU touch: re-insert at the most-recently-used end.
      this.#map.delete(key);
      this.#map.set(key, value);
    }
    return value;
  }

  set(key: string, dims: ImageDimensions): void {
    if (this.#map.has(key)) {
      this.#map.delete(key);
    }
    this.#map.set(key, dims);
    while (this.#map.size > this.max) {
      const oldest = this.#map.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.#map.delete(oldest);
    }
  }

  clear(): void {
    this.#map.clear();
  }

  get size(): number {
    return this.#map.size;
  }
}

// Module singleton. One webview hosts one document, so a process-wide cache
// keyed by resolved URI cannot collide across documents. 256 entries bounds
// memory while covering any realistic note's image count.
export const imageDimensionCache = new ImageDimensionCache(256);
