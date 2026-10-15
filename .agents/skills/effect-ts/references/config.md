# Config

Use this when reading environment settings, selecting a provider, or building a
config-backed layer. Read configuration through `Config` and `ConfigProvider`,
never `process.env` inside Effect operations. Target installed Effect 4.0.5; verify
unfamiliar APIs in the installed Config and ConfigProvider sources.

## Define Typed Recipes

Treat configuration as an ingress boundary: parse it near startup, then provide
a domain configuration service to business code when that improves the seam.

```ts
import { Config, Effect } from "effect"

export const loadSettings = Effect.fn("Configuration.loadSettings")(function* () {
  const apiKey = yield* Config.Redacted("API_KEY")
  const model = yield* Config.option(Config.String("MODEL"))
  const enabled = yield* Config.Boolean("FEATURE_ENABLED").pipe(
    Config.withDefault(false)
  )
  return { apiKey, model, enabled }
})
```

Use `Config.schema` for refined values and `Config.mapEffect` for effectful
validation returning `ConfigError`. Use `Config.Redacted` for credentials and
`Config.option` when absence has domain
meaning. Use `Config.withDefault` only for a missing value: malformed values
still fail. Use `Config.orElse` only when intentionally recovering from every
configuration parse failure.

## Install Providers at the Boundary

The default provider reads the environment. Install or compose providers at an
application or test boundary:

- Use `ConfigProvider.fromEnv` for environment variables.
- Use `ConfigProvider.fromUnknown` for deterministic tests or parsed data.
- Pipe a provider through `ConfigProvider.constantCase` to map camelCase keys to
  `SCREAMING_SNAKE_CASE` variables.
- Use `ConfigProvider.nested` to scope a provider under a prefix.
- Use `ConfigProvider.layer` to replace the active provider.
- Use `ConfigProvider.layerAdd` for fallbacks; pass `{ asPrimary: true }` only
  when the added provider must override the current source.

```ts
import { ConfigProvider } from "effect"

const testProvider = ConfigProvider.fromUnknown({ PORT: "4000" })
export const TestConfig = ConfigProvider.layer(testProvider)

const defaults = ConfigProvider.fromUnknown({ PORT: "3000" })
export const ConfigDefaults = ConfigProvider.layerAdd(defaults)

const overrides = ConfigProvider.fromUnknown({ PORT: "5000" })
export const ConfigOverrides = ConfigProvider.layerAdd(overrides, {
  asPrimary: true
})
```

`layer` replaces the provider. `layerAdd` is a fallback by default; only
`asPrimary: true` makes the added provider win. Keep this precedence visible in
tests rather than relying on Layer composition order to imply it.

Use `Config.Wrap<T>` with `Config.unwrap` for a library-style `layerConfig`
helper. Otherwise prefer a concrete layer or a domain configuration service so
tests can provide known values without exercising parsing.
