/**
 * The application this codebase is.
 *
 * Split out of `authorization.ts` for the same reason as the role order: that
 * module is `server-only`, and the admin editor is a client component that
 * legitimately needs this string to render a toggle.
 *
 * A constant rather than an env var. Which product this is does not vary by
 * deployment, and an env var would turn "granted access to the wrong app" from
 * an impossible state into a configuration mistake.
 */
export const APP_ACCESS_KEY = "vizserve-pms";
