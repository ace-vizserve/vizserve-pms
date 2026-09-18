// Runs on `npm install` (the `prepare` script). Points git at the tracked
// .githooks/ directory, then runs post-checkout once so the current branch's
// author email is right without waiting for the next checkout.
// Silent and non-fatal outside a git checkout — Vercel's build has none.
import { execSync } from 'node:child_process'

try {
  execSync('git rev-parse --git-dir', { stdio: 'ignore' })
  execSync('git config core.hooksPath .githooks', { stdio: 'ignore' })
  execSync('sh .githooks/post-checkout', { stdio: 'ignore' })
} catch {
  // not a git checkout, or git/sh unavailable — nothing to install
}
