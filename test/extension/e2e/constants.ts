// Test-side mirror of src/shared/protocol.ts PROTOCOL_VERSION.
//
// Why duplicate the literal: the E2E suite compiles to CommonJS in
// out/test-e2e/ with rootDir `.`. Reaching into ../../src/shared/
// either pulls a .ts file the CJS bundle can't load or forces tsc
// to widen rootDir and re-emit the entire src/ tree. Keeping a
// 1-line constant here and a vitest guard test
// (test/shared/protocol-version.test.ts) that asserts the two stay
// in sync is the minimal-coupling solution.

export const PROTOCOL_VERSION = 1;
