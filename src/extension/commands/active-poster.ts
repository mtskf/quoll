// A single-slot "active panel poster" latch with identity-guarded clear: a
// panel that lost focus AFTER another became active must not wipe the newer
// poster. Backs both the active-panel post (host commands) and the switch
// poster, so the latch semantics live in exactly one place.
export function createActivePoster<T extends (...args: never[]) => void>(): {
  set(poster: T): void;
  clear(poster: T): void;
  get(): T | null;
} {
  let active: T | null = null;
  return {
    set: (poster) => {
      active = poster;
    },
    clear: (poster) => {
      if (active === poster) {
        active = null;
      }
    },
    get: () => active,
  };
}
