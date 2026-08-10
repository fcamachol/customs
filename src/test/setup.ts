// Vitest test-environment setup.
//
// Node (>=22, and unconditionally as of the v26 runtime this repo's tests run under)
// ships its own global `localStorage`/`sessionStorage` accessors that are inert unless
// `--localstorage-file` is passed. Vitest's jsdom environment only overrides a global
// with jsdom's implementation when the key is either absent from `globalThis` or in its
// known KEYS list — and it does not consider `localStorage`/`sessionStorage` at all, and
// they ARE already present as Node's own inert accessors. Net effect: `globalThis.localStorage`
// silently resolves to Node's broken stub instead of jsdom's working `window.localStorage`,
// so any component that touches localStorage on mount (e.g. AuthContext) throws
// "Cannot read properties of undefined (reading 'getItem')".
//
// Fix: explicitly repoint the globals at jsdom's storage objects before any test runs.
//
// Note: vitest's jsdom environment aliases the global `window` to `globalThis` itself
// (`global.window = global`), so `window.localStorage` here would just re-read the same
// broken alias. The real jsdom Window instance — with a working `localStorage` — is only
// reachable via `globalThis.jsdom.window`, which vitest stashes there for exactly this
// kind of low-level access.
const dom = (globalThis as { jsdom?: { window?: Window } }).jsdom;
if (dom?.window) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: dom.window.localStorage,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: dom.window.sessionStorage,
    configurable: true,
    writable: true,
  });
}
