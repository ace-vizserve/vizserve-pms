/**
 * Stub for the `server-only` build-time marker package.
 *
 * `server-only` has no runtime behaviour at all — it is a poison-pill module
 * that makes `next build` fail if a server file is pulled into a client bundle.
 * Vitest does not run that bundler step, so the import must resolve to
 * something. This is that something.
 *
 * The real check still happens: `npm run build` is unaffected by this file.
 */
export {};
