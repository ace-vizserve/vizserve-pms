# Tarsi Web

## Mission

Create implementation-ready, token-driven UI guidance for Tarsi Web that is optimized for consistency, accessibility, and fast delivery across content site.

## Brand

- Product/brand: Tarsi Web
- URL: https://app.tarsi.cloud/
- Audience: readers and knowledge seekers
- Product surface: content site

## Style Foundations

- Visual style: clean, functional, implementation-oriented
- Main font style: `font.family.primary=openRunde`, `font.family.stack=openRunde, openRunde Fallback, Avenir Next, Segoe UI, Helvetica Neue, Arial, sans-serif`, `font.size.base=16px`, `font.weight.base=500`, `font.lineHeight.base=24.8px`
- Typography scale: `font.size.xs=11px`, `font.size.sm=12px`, `font.size.md=13px`, `font.size.lg=14px`, `font.size.xl=16px`, `font.size.2xl=18px`, `font.size.3xl=22px`, `font.size.4xl=26px`
- Color palette: `color.text.primary=#292929`, `color.text.secondary=#5d5d5d`, `color.text.tertiary=#2f6a3b`, `color.surface.muted=#ffffff`, `color.surface.base=#000000`, `color.surface.raised=oklab(0.962038 0.00112626 0.0114246 / 0.8)`, `color.surface.strong=#516858`
- Spacing scale: `space.1=2px`, `space.2=4px`, `space.3=6px`, `space.4=8px`, `space.5=10px`, `space.6=12px`, `space.7=14px`, `space.8=16px`
- Radius/shadow/motion tokens: `radius.xs=8px`, `radius.sm=16px`, `radius.md=33554400px` | `shadow.1=color(srgb 0.313726 0.541176 0.34902 / 0.05) 0px 25px 50px 0px, color(srgb 0.313726 0.541176 0.34902 / 0.04) 0px 12px 24px 0px, color(srgb 0.313726 0.541176 0.34902 / 0.03) 0px 6px 12px 0px, color(srgb 0.313726 0.541176 0.34902 / 0.02) 0px 3px 6px 0px, color(srgb 0.313726 0.541176 0.34902 / 0.02) 0px 1.5px 3px 0px`, `shadow.2=color(srgb 0.313726 0.541176 0.34902 / 0.04) 0px 17.54px 23.39px 0px, color(srgb 0.313726 0.541176 0.34902 / 0.03) 0px 9.4px 12.5px 0px, color(srgb 0.313726 0.541176 0.34902 / 0.02) 0px 5.25px 7px 0px, color(srgb 0.313726 0.541176 0.34902 / 0.00999999) 0px 2.79px 3.72px -2px, color(srgb 0.313726 0.541176 0.34902 / 0.00999999) 0px 1.16px 1.5px 0px` | `motion.duration.instant=150ms`, `motion.duration.fast=200ms`

## Accessibility

- Target: WCAG 2.2 AA
- Keyboard-first interactions required.
- Focus-visible rules required.
- Contrast constraints required.

## Writing Tone

Concise, confident, implementation-focused.

## Rules: Do

- Use semantic tokens, not raw hex values, in component guidance.
- Every component must define states for default, hover, focus-visible, active, disabled, loading, and error.
- Component behavior should specify responsive and edge-case handling.
- Interactive components must document keyboard, pointer, and touch behavior.
- Accessibility acceptance criteria must be testable in implementation.

## Rules: Don't

- Do not allow low-contrast text or hidden focus indicators.
- Do not introduce one-off spacing or typography exceptions.
- Do not use ambiguous labels or non-descriptive actions.
- Do not ship component guidance without explicit state rules.

## Guideline Authoring Workflow

1. Restate design intent in one sentence.
2. Define foundations and semantic tokens.
3. Define component anatomy, variants, interactions, and state behavior.
4. Add accessibility acceptance criteria with pass/fail checks.
5. Add anti-patterns, migration notes, and edge-case handling.
6. End with a QA checklist.

## Required Output Structure

- Context and goals.
- Design tokens and foundations.
- Component-level rules (anatomy, variants, states, responsive behavior).
- Accessibility requirements and testable acceptance criteria.
- Content and tone standards with examples.
- Anti-patterns and prohibited implementations.
- QA checklist.

## Component Rule Expectations

- Include keyboard, pointer, and touch behavior.
- Include spacing and typography token requirements.
- Include long-content, overflow, and empty-state handling.
- Include known page component density: cards (68), buttons (28), links (4), navigation (1).

- Extraction diagnostics: Audience and product surface inference confidence is low; verify generated brand context.

## Quality Gates

- Every non-negotiable rule must use "must".
- Every recommendation should use "should".
- Every accessibility rule must be testable in implementation.
- Teams should prefer system consistency over local visual exceptions.
