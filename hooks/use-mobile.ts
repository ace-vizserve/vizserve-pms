import * as React from "react"

const MOBILE_BREAKPOINT = 768
const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

/**
 * Is the viewport below the mobile breakpoint?
 *
 * Rewritten from the upstream template's `useState` + `useEffect` version,
 * which set state synchronously inside the effect body. That causes a cascading
 * render on every mount and our lint rules reject it outright.
 *
 * `useSyncExternalStore` is the right shape for this: the media query IS an
 * external store, so React subscribes to it directly and reads the current
 * value during render rather than after paint. That also removes the one-frame
 * flash where the sidebar rendered desktop-width before correcting itself.
 */
function subscribe(onChange: () => void) {
  const mql = window.matchMedia(QUERY)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

function getSnapshot() {
  return window.matchMedia(QUERY).matches
}

// There is no viewport on the server. Desktop is the safer default: the mobile
// branch renders a Sheet, and mounting one during hydration is worse than a
// layout correction.
function getServerSnapshot() {
  return false
}

export function useIsMobile() {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
