# @rc312/tss-effect-serverfn

## 0.2.1

### Patch Changes

- 56e4c81: Raise the minimum supported Effect version to 4.1.7 and update Effect's Vitest integration to 4.1.7.

## 0.2.0

### Minor Changes

- Upgrade Effect support to 4.1.2 and require Node.js 22.19 or newer to match Effect's runtime requirements.

  Effect 4.1 promotes typed failures to defects when combined with cleanup defects.

## 0.1.0

### Minor Changes

- e732bfc: Implement typed TanStack Start Effect handlers, runner middleware, safe failure boundaries, validation and observation helpers, and server-only failure provenance hooks.

  Guard failure inspection, align composed runner inference with execution order, bound request-owned reporting, and expose original setup causes through server-only diagnostics.
