# Vendored anti-slop

- Source: https://github.com/dmmulroy/anti-slop
- Revision: `13909c9e07590f5a85d93c62712259fe14a883f7`
- Copied: upstream `src/` and root `LICENSE`, without modifications.
- License: MIT. Additional third-party notices are in `vendor/`.

The root Oxlint config enables all generic rules, all five Effect-specific rules,
and the companion native `oxc/no-accumulating-spread` rule.

Keep `oxlint` and `@oxlint/plugins` pinned to the same exact version when
upgrading. Review upstream changes against this revision before updating the
vendored source; preserve any future local customizations.
