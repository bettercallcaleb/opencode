# Enterprise runtime egress audit

Audit date: 2026-07-14

## Scope and policy

This is a static audit of production code reachable from the OpenCode CLI, TUI, server, web app, and desktop application. It focuses on network activity after the built application starts. Test fixtures, documentation sites, hosted console/function services, and release automation are not treated as part of the installed application's runtime unless their code or configuration is embedded into that runtime.

The enterprise boundary used by this audit is:

- Development, dependency installation, CI, packaging, and release-time network access are allowed.
- Normal `bun install`, workspace dependency declarations, registry configuration, lockfiles, and build scripts are not prohibited and must not be removed merely because they use the network during development or CI.
- After OpenCode starts, no outbound connection is allowed except to one future explicitly configured internal vLLM endpoint.
- Loopback traffic between OpenCode components is not outbound egress and may remain, but user-configurable remote OpenCode server connections must be rejected in enterprise mode.
- Any package, plugin, skill, parser, formatter, LSP, binary, application update, or other on-demand runtime download is prohibited.
- A user action does not make runtime egress acceptable. Manual update, login, web tools, opening a remote share, and asking the shell to run `curl` are still runtime egress.

`OPENCODE_ENTERPRISE_MODE` currently affects only `Flag.OPENCODE_DISABLE_AUTOUPDATE`, `Flag.OPENCODE_DISABLE_MODELS_FETCH`, and `Flag.OPENCODE_DISABLE_SHARE` in `packages/core/src/flag/flag.ts`. It is not a general network boundary.

## Executive summary

The repository is not yet safe to run under the stated enterprise boundary. The existing enterprise flag prevents the ordinary CLI automatic-update path, normal models.dev population/background refresh, and ShareNext create/sync/remove operations. It does not prevent all alternate entry points for those features, and it does not cover desktop updating, plugins, runtime package installation, MCP, web tools, remote configuration/instructions/skills, LSP and parser downloads, telemetry, authentication, arbitrary providers, remote UI proxying, remote workspace proxying, or shell/process escape hatches.

The most important gaps are:

1. Runtime installation is centralized in `Npm.reify`, but no enterprise guard prevents Arborist from contacting the configured npm registry. Plugin loading, dynamic providers, config dependencies, formatters, and several LSPs reach this path.
2. `ModelsDev.refresh(true)` bypasses the enterprise-controlled checks used by population and the hourly scheduler.
3. Desktop update checks/downloads are independent of `Flag.OPENCODE_DISABLE_AUTOUPDATE` and run at startup and every ten minutes in packaged builds.
4. Both legacy and V2 web tools can contact arbitrary URLs or Exa/Parallel and are normally registered.
5. Remote MCP and local MCP subprocesses are started without an enterprise restriction; a local MCP process can itself make arbitrary connections.
6. LSPs, ripgrep, remote skills, formatter packages, project config dependencies, and TUI tree-sitter assets can download or install during runtime.
7. Sentry and OTLP can export at runtime, and account/provider OAuth plus inference transports can contact many public services.
8. The shell tools and plugin code are general-purpose execution boundaries. Feature flags alone cannot prove zero egress while arbitrary commands or third-party code can run.

## Findings

### EGR-01: CLI automatic update check and patch upgrade

- **Category:** Automatic update/version checks
- **Source file:** `packages/opencode/src/cli/upgrade.ts`; `packages/opencode/src/installation/index.ts`
- **Function or symbol:** `upgrade`; `Installation.latest`; `Installation.upgrade`; `upgradeCurl`
- **Destination or URL source:** npm registry from `NpmConfig.registry`; `https://api.github.com/repos/anomalyco/opencode/releases/latest`; Homebrew, Chocolatey, and Scoop metadata URLs; `https://opencode.ai/install`; package managers and `git pull` during upgrade
- **Trigger condition:** CLI startup invokes `upgrade`; if enabled it detects the installation method, checks the current version, and may install patch releases.
- **Build time or runtime:** Runtime
- **Already disabled by `OPENCODE_ENTERPRISE_MODE`:** **Yes for this automatic entry point.** `Flag.OPENCODE_DISABLE_AUTOUPDATE` returns early before method detection or version lookup.
- **Recommended enterprise treatment:** **disable**
- **Risk and notes:** The current guard is appropriate for automatic CLI checks. Keep a focused regression test because this is a high-value boundary. The underlying `Installation` service remains callable through other paths.

### EGR-02: Manual update command and installation service

- **Category:** Updates and runtime package-manager execution
- **Source file:** `packages/opencode/src/cli/cmd/upgrade.ts`; `packages/opencode/src/installation/index.ts`
- **Function or symbol:** `UpgradeCommand.handler`; `Installation.latest`; `Installation.upgrade`
- **Destination or URL source:** Same metadata, install script, registry, GitHub, package-manager, Homebrew, Chocolatey, and Scoop destinations as EGR-01
- **Trigger condition:** User runs `opencode upgrade`, optionally with a target version or method.
- **Build time or runtime:** Runtime
- **Already disabled by `OPENCODE_ENTERPRISE_MODE`:** **No.** The command does not check the enterprise-derived update flag.
- **Recommended enterprise treatment:** **disable**
- **Risk and notes:** This path downloads and executes code or invokes a package manager during application runtime, which is prohibited even though it is explicit and user initiated.

### EGR-03: Desktop updater

- **Category:** Desktop-specific update behavior
- **Source file:** `packages/desktop/src/main/updater.ts`; `packages/desktop/src/main/updater-controller.ts`; `packages/desktop/src/main/index.ts`; `packages/desktop/electron-builder.config.ts`
- **Function or symbol:** `setupAutoUpdater`; `createUpdaterController.check`; `updater.start`; periodic `updater.check`
- **Destination or URL source:** GitHub release feeds embedded by electron-builder (`anomalyco/opencode` or `anomalyco/opencode-beta`) and release asset URLs resolved by `electron-updater`
- **Trigger condition:** Packaged non-development desktop app starts; it checks immediately, every ten minutes, and on manual check. A found update can be downloaded and installed.
- **Build time or runtime:** Feed metadata is embedded at build time; checks and downloads are runtime.
- **Already disabled by `OPENCODE_ENTERPRISE_MODE`:** **No.** `UPDATER_ENABLED` only checks `app.isPackaged` and channel.
- **Recommended enterprise treatment:** **disable**
- **Risk and notes:** This is an independent updater and must be guarded separately from CLI autoupdate. Hiding the menu is insufficient; `setupAutoUpdater`, startup, timer, IPC, and downloads must all be inert.

### EGR-04: models.dev catalog

- **Category:** models.dev catalog fetching
- **Source file:** `packages/core/src/models-dev.ts`; `packages/opencode/src/cli/cmd/models.ts`
- **Function or symbol:** `ModelsDev.fetchApi`; `fetchAndWrite`; `populate`; `refresh`; models refresh command
- **Destination or URL source:** `${OPENCODE_MODELS_URL || "https://models.dev"}/api.json`
- **Trigger condition:** First catalog use without a disk/snapshot value; hourly background refresh; explicit models refresh command.
- **Build time or runtime:** Runtime
- **Already disabled by `OPENCODE_ENTERPRISE_MODE`:** **Partial.** `populate` and the hourly scheduler check `Flag.OPENCODE_DISABLE_MODELS_FETCH`, but `refresh(force)` and `fetchAndWrite` do not. `refresh(true)` still fetches.
- **Recommended enterprise treatment:** **disable**
- **Risk and notes:** Put the guard at or below `fetchAndWrite` so every caller is covered. Enterprise deployments will need a built-in or administrator-provisioned catalog for the future vLLM model.

### EGR-05: Session sharing

- **Category:** Session sharing
- **Source file:** `packages/opencode/src/share/share-next.ts`; `packages/opencode/src/share/session.ts`
- **Function or symbol:** `ShareNext.create`; `sync`; `flush`; `remove`; `SessionShare.share`
- **Destination or URL source:** `https://opncd.ai` by default, configured `enterprise.url`, or active account URL; `/api/share` and `/api/shares` endpoints
- **Trigger condition:** Manual share, `--share`, auto-share configuration, or updates to an already shared session.
- **Build time or runtime:** Runtime
- **Already disabled by `OPENCODE_ENTERPRISE_MODE`:** **Yes for ShareNext network mutations.** The centralized `Flag.OPENCODE_DISABLE_SHARE` blocks initialization, create, sync/flush, and remove.
- **Recommended enterprise treatment:** **disable**
- **Risk and notes:** The disabled `create` returns an empty share object rather than a typed disabled error, and higher layers may write an empty share URL. That is a correctness issue but not direct egress. Preserve a defense at the lowest HTTP boundary.

### EGR-06: Importing a session from a share or arbitrary URL

- **Category:** Session sharing / arbitrary remote import
- **Source file:** `packages/opencode/src/cli/cmd/import.ts`
- **Function or symbol:** `runImport`; local `tryFetch`
- **Destination or URL source:** Origin supplied by the `import <file>` argument, with share data paths derived from `ShareNext.request`
- **Trigger condition:** User passes an `http://` or `https://` URL to `opencode import`.
- **Build time or runtime:** Runtime
- **Already disabled by `OPENCODE_ENTERPRISE_MODE`:** **No.** The command calls global `fetch` directly and does not consult `Flag.OPENCODE_DISABLE_SHARE`.
- **Recommended enterprise treatment:** **disable**
- **Risk and notes:** This is both an enterprise-sharing bypass and arbitrary outbound HTTP. Local-file import can be kept.

### EGR-07: External plugin loading and on-demand npm installation

- **Category:** Plugin loading and runtime npm installation
- **Source file:** `packages/opencode/src/plugin/index.ts`; `packages/opencode/src/plugin/loader.ts`; `packages/opencode/src/plugin/shared.ts`; `packages/opencode/src/plugin/install.ts`; `packages/opencode/src/plugin/tui/runtime.ts`; `packages/core/src/config/plugin/external.ts`; `packages/core/src/npm.ts`
- **Function or symbol:** `PluginLoader.resolve`; `resolvePluginTarget`; `installPlugin`; `installPluginBySpec`; `ConfigExternalPlugin.Plugin`; `Npm.add`; `Npm.reify`
- **Destination or URL source:** npm registry selected by npm configuration, defaulting to `https://registry.npmjs.org`; package tarball URLs supplied by registry metadata
- **Trigger condition:** Config contains npm plugin specs, the TUI plugin palette installs a plugin, `opencode plug` runs, or the Effect plugin system encounters a non-local plugin.
- **Build time or runtime:** Runtime
- **Already disabled by `OPENCODE_ENTERPRISE_MODE`:** **No.** `OPENCODE_PURE` and `OPENCODE_DISABLE_DEFAULT_PLUGINS` are separate flags and are not implied by enterprise mode.
- **Recommended enterprise treatment:** **disable**
- **Risk and notes:** Runtime plugin installation is explicitly prohibited. Local plugin execution also expands the trusted code base and can call the network itself; enterprise mode should load only an immutable, build-time allowlist, if any.

### EGR-08: Automatic config-directory dependency installation

- **Category:** Runtime dependency installation
- **Source file:** `packages/opencode/src/config/config.ts`; `packages/opencode/src/config/tui.ts`; `packages/core/src/npm.ts`
- **Function or symbol:** config layer calls to `npmSvc.install`; `TuiConfig` dependency fibers; `Npm.install`; `Npm.reify`
- **Destination or URL source:** Configured npm registry and package tarballs
- **Trigger condition:** OpenCode discovers writable config directories and their `node_modules` is absent or lock/package metadata is considered dirty; `@opencode-ai/plugin` may be added.
- **Build time or runtime:** Runtime, often in a detached background fiber during config loading
- **Already disabled by `OPENCODE_ENTERPRISE_MODE`:** **No.** This happens independently of project-config and plugin execution flags.
- **Recommended enterprise treatment:** **disable**
- **Risk and notes:** This can produce startup-time egress even when no explicit install command is run. Pre-provision dependencies at build/deployment time or reject configs requiring them.

### EGR-09: Dynamic provider package installation

- **Category:** Dynamic provider/package installation
- **Source file:** `packages/opencode/src/provider/provider.ts`; `packages/core/src/plugin/provider/dynamic.ts`; `packages/core/src/plugin/provider/sap-ai-core.ts`; `packages/core/src/npm.ts`
- **Function or symbol:** `resolveSDK`; `DynamicProviderPlugin`; `SapAICorePlugin`; `Npm.add`
- **Destination or URL source:** npm registry and tarball selected by the model/provider `api.npm` package spec
- **Trigger condition:** A selected model names a provider package not present in `BUNDLED_PROVIDERS` or the V2 provider plugin requests a non-file package.
- **Build time or runtime:** Runtime, commonly on first model use
- **Already disabled by `OPENCODE_ENTERPRISE_MODE`:** **No.**
- **Recommended enterprise treatment:** **disable**
- **Risk and notes:** Enterprise mode should accept only a build-bundled adapter for the future internal vLLM endpoint. A provider catalog entry must never be able to cause installation.

### EGR-10: Formatter package installation

- **Category:** Runtime tool/package installation
- **Source file:** `packages/opencode/src/format/formatter.ts`; `packages/core/src/npm.ts`
- **Function or symbol:** `prettier.enabled`; `oxfmt.enabled`; `biome.enabled`; `Npm.which`
- **Destination or URL source:** npm registry for `prettier`, `oxfmt`, or `@biomejs/biome`
- **Trigger condition:** A matching project manifest/config exists, formatting is enabled, and the cached binary is missing.
- **Build time or runtime:** Runtime
- **Already disabled by `OPENCODE_ENTERPRISE_MODE`:** **No.**
- **Recommended enterprise treatment:** **disable** runtime installation; **keep** only already installed local binaries
- **Risk and notes:** `Npm.which` calls `Npm.add` when its cache has no executable. Its name obscures the fact that it may download.

### EGR-11: Remote MCP transports and OAuth

- **Category:** Remote MCP connections
- **Source file:** `packages/opencode/src/mcp/index.ts`; `packages/opencode/src/mcp/oauth-provider.ts`; `packages/opencode/src/cli/cmd/mcp.ts`
- **Function or symbol:** `MCP.connectRemote`; `connectTransport`; `startAuth`; `authenticate`; MCP debug transport
- **Destination or URL source:** Arbitrary configured `mcp.url`; OAuth discovery, registration, authorization, and token endpoints returned by the MCP server
- **Trigger condition:** Enabled remote MCP entries connect concurrently during MCP state initialization, or a user invokes add/connect/auth/debug commands.
- **Build time or runtime:** Runtime
- **Already disabled by `OPENCODE_ENTERPRISE_MODE`:** **No.**
- **Recommended enterprise treatment:** **disable**
- **Risk and notes:** Both Streamable HTTP and SSE transports are attempted. An allowlist is not needed under the current boundary because only future vLLM is permitted and MCP is not vLLM.

### EGR-12: Local MCP subprocesses

- **Category:** MCP / child-process egress
- **Source file:** `packages/opencode/src/mcp/index.ts`
- **Function or symbol:** `MCP.connectLocal`; `StdioClientTransport`
- **Destination or URL source:** Configured executable and arguments; any destinations chosen by that child process
- **Trigger condition:** Enabled local MCP entry initializes or is explicitly connected.
- **Build time or runtime:** Runtime
- **Already disabled by `OPENCODE_ENTERPRISE_MODE`:** **No.**
- **Recommended enterprise treatment:** **disable**, or **restrict to allowlist** only after OS-level network isolation is proven
- **Risk and notes:** Stdio is local transport, but the spawned MCP server is arbitrary code and can make outbound connections. An application-level HTTP guard cannot contain it.

### EGR-13: webfetch tools

- **Category:** Webfetch
- **Source file:** `packages/opencode/src/tool/webfetch.ts`; `packages/core/src/tool/webfetch.ts`
- **Function or symbol:** legacy `WebFetchTool`; V2 `WebFetchTool` registration and `execute`
- **Destination or URL source:** Arbitrary user/model-supplied HTTP or HTTPS URL, including redirects handled by the HTTP stack
- **Trigger condition:** Tool is registered and invoked after its permission check.
- **Build time or runtime:** Runtime
- **Already disabled by `OPENCODE_ENTERPRISE_MODE`:** **No.** Default agent permissions allow webfetch.
- **Recommended enterprise treatment:** **disable**
- **Risk and notes:** Permission prompts are a user-consent mechanism, not an egress boundary. URL validation permits all HTTP(S) hosts and can reach internal metadata/services unless separately constrained.

### EGR-14: websearch tools

- **Category:** Websearch
- **Source file:** `packages/opencode/src/tool/websearch.ts`; `packages/opencode/src/tool/mcp-websearch.ts`; `packages/core/src/tool/websearch.ts`
- **Function or symbol:** legacy and V2 `WebSearchTool`; `McpWebSearch.call`; V2 `callMcp`
- **Destination or URL source:** `https://mcp.exa.ai/mcp` or `https://search.parallel.ai/mcp`, optionally with API credentials
- **Trigger condition:** Tool invocation; provider selection defaults to Exa or Parallel even when no explicit enable flag is set.
- **Build time or runtime:** Runtime
- **Already disabled by `OPENCODE_ENTERPRISE_MODE`:** **No.**
- **Recommended enterprise treatment:** **disable**
- **Risk and notes:** Merely forcing `enableExa` and `enableParallel` false is insufficient because selection falls back to one of the two services.

### EGR-15: Remote instruction loading

- **Category:** Remote instruction URL loading
- **Source file:** `packages/opencode/src/session/instruction.ts`
- **Function or symbol:** `Instruction.fetch`; `Instruction.system`
- **Destination or URL source:** Every HTTP(S) URL in `config.instructions`
- **Trigger condition:** Session system instructions are assembled.
- **Build time or runtime:** Runtime
- **Already disabled by `OPENCODE_ENTERPRISE_MODE`:** **No.** `OPENCODE_DISABLE_PROJECT_CONFIG` does not disable remote global instructions and is not implied by enterprise mode.
- **Recommended enterprise treatment:** **disable** remote URLs; **keep** local instruction files
- **Risk and notes:** Content becomes trusted model instructions as well as causing egress, creating a remote prompt-supply-chain risk.

### EGR-16: Remote well-known and account configuration

- **Category:** Remote configuration and account endpoints
- **Source file:** `packages/opencode/src/config/config.ts`; `packages/opencode/src/account/account.ts`; `packages/core/src/plugin/provider/opencode.ts`
- **Function or symbol:** `fetchRemoteJson`; `Config.loadInstanceState`; `Account.config`; `OpencodePlugin.fetchProviders`
- **Destination or URL source:** Stored account/auth server URL, `${url}/.well-known/opencode`, well-known `remote_config.url`, `${account.url}/api/config`, default `https://console.opencode.ai`
- **Trigger condition:** A stored `wellknown` auth entry or active account exists; instance config/provider catalog initializes.
- **Build time or runtime:** Runtime, potentially during ordinary instance startup
- **Already disabled by `OPENCODE_ENTERPRISE_MODE`:** **No.**
- **Recommended enterprise treatment:** **disable**
- **Risk and notes:** Remote config can also introduce providers, plugin specs, skills, instructions, MCP entries, and other secondary egress configuration. Enterprise configuration should be local and administrator provisioned.

### EGR-17: Remote skill indexes and files

- **Category:** Runtime downloading / remote configuration
- **Source file:** `packages/opencode/src/skill/discovery.ts`; `packages/core/src/skill/discovery.ts`; `packages/opencode/src/skill/index.ts`; `packages/core/src/config/plugin/skill.ts`
- **Function or symbol:** legacy `Discovery.pull`; V2 `SkillDiscovery.pull`; `download`; URL `SkillV2.Source`
- **Destination or URL source:** Arbitrary configured skill base URL, its `index.json`, and same-origin skill files
- **Trigger condition:** Config contains legacy `skills.urls` or a V2 HTTP(S) skill source and skills initialize.
- **Build time or runtime:** Runtime
- **Already disabled by `OPENCODE_ENTERPRISE_MODE`:** **No.** `OPENCODE_DISABLE_EXTERNAL_SKILLS` only suppresses discovered Claude/agent directories in the legacy path; configured URLs still pull, and enterprise mode does not imply that flag.
- **Recommended enterprise treatment:** **disable** remote sources; **keep** local or embedded skills
- **Risk and notes:** This is an on-demand content download and remote prompt/code supply-chain path.

### EGR-18: LSP automatic downloads and installers

- **Category:** LSP/server automatic downloading or installation
- **Source file:** `packages/opencode/src/lsp/server.ts`; `packages/core/src/npm.ts`
- **Function or symbol:** language server `spawn` implementations; `Npm.which`; direct `fetch`; `Process.spawn` installers
- **Destination or URL source:** npm registry; GitHub release/API/raw archives; Eclipse and JetBrains downloads; HashiCorp release API/assets; Go modules; RubyGems; NuGet/dotnet tools; Mix/Hex dependencies
- **Trigger condition:** A supported source file activates an LSP whose binary is missing.
- **Build time or runtime:** Runtime
- **Already disabled by `OPENCODE_ENTERPRISE_MODE`:** **No.** `OPENCODE_DISABLE_LSP_DOWNLOAD` covers most explicit download branches but is not implied by enterprise mode. Some `Npm.which` calls, notably TypeScript and Biome paths, are not consistently guarded before they may install.
- **Recommended enterprise treatment:** **disable** every installer/download; **keep** only preinstalled, allowlisted binaries
- **Risk and notes:** Guard the shared installation boundary as well as individual servers. Child LSP binaries may themselves contact networks for telemetry, dependency resolution, or language features; OS containment may still be required.

### EGR-19: Ripgrep binary download

- **Category:** Runtime binary download
- **Source file:** `packages/core/src/ripgrep/binary.ts`
- **Function or symbol:** `RipgrepBinary.Service.filepath`
- **Destination or URL source:** `https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/...`
- **Trigger condition:** A system/cached `rg` executable is absent and a grep/glob/filesystem search first needs it.
- **Build time or runtime:** Runtime
- **Already disabled by `OPENCODE_ENTERPRISE_MODE`:** **No.**
- **Recommended enterprise treatment:** **disable** download and package `rg` in the enterprise artifact, or fail with a clear preflight error
- **Risk and notes:** Search is core functionality, so silently disabling the tool is less desirable than bundling a verified binary at build time.

### EGR-20: TUI tree-sitter parser and query assets

- **Category:** Runtime parser download
- **Source file:** `packages/tui/src/parsers-config.ts`; `packages/tui/src/routes/session/index.tsx`
- **Function or symbol:** parser URL table; `addDefaultParsers`
- **Destination or URL source:** Numerous GitHub release, GitHub raw, and `raw.githubusercontent.com` URLs for WASM grammars and query files
- **Trigger condition:** TUI registers URL-backed parsers; the OpenTUI parser loader may fetch an asset when syntax highlighting first needs that language.
- **Build time or runtime:** Runtime according to the URL-backed configuration; dependency implementation should be verified with an instrumented test.
- **Already disabled by `OPENCODE_ENTERPRISE_MODE`:** **No.**
- **Recommended enterprise treatment:** **disable** URL loading and bundle required assets at build time; **investigate** the dependency cache/trigger details
- **Risk and notes:** This is easy to miss because production OpenCode code supplies URLs but the actual fetch occurs in `@opentui/core`.

### EGR-21: OpenTelemetry export

- **Category:** Telemetry / OpenTelemetry
- **Source file:** `packages/core/src/observability.ts`; `packages/core/src/observability/otlp.ts`
- **Function or symbol:** `Otlp.loggers`; `Otlp.tracingLayer`
- **Destination or URL source:** `OTEL_EXPORTER_OTLP_ENDPOINT` plus `/v1/logs` and `/v1/traces`
- **Trigger condition:** Endpoint environment variable is present; observability layer initializes and batches logs/traces.
- **Build time or runtime:** Runtime
- **Already disabled by `OPENCODE_ENTERPRISE_MODE`:** **No.**
- **Recommended enterprise treatment:** **disable**
- **Risk and notes:** The stated boundary permits only vLLM, so even an internal OTLP endpoint is outside the current allowance. AI SDK telemetry spans can include operational/model metadata.

### EGR-22: Sentry and local crash reporting

- **Category:** Analytics, crash reporting, and Sentry
- **Source file:** `packages/app/src/entry.tsx`; `packages/app/src/app.tsx`; `packages/app/src/pages/error.tsx`; `packages/desktop/src/renderer/index.tsx`; `packages/desktop/src/main/logging.ts`
- **Function or symbol:** `Sentry.init`; `Sentry.captureException`; `initCrashReporter`
- **Destination or URL source:** Build-provided `VITE_SENTRY_DSN`; Electron Crashpad directory on local disk
- **Trigger condition:** Sentry DSN was embedded at build time and runtime errors are captured or explicitly reported. Electron crash reporter always starts, but `uploadToServer: false`.
- **Build time or runtime:** DSN injection is build time; Sentry export and crash capture are runtime.
- **Already disabled by `OPENCODE_ENTERPRISE_MODE`:** **No for Sentry.** Local Crashpad does not upload.
- **Recommended enterprise treatment:** **disable** Sentry; **keep** local Crashpad with uploads off
- **Risk and notes:** Enterprise builds should omit the DSN and add a runtime guard for defense in depth. Local debug/crash files can contain sensitive data but are not egress by themselves.

### EGR-23: Account login, refresh, organizations, and provider OAuth

- **Category:** Authentication or account endpoints
- **Source file:** `packages/opencode/src/account/account.ts`; `packages/core/src/plugin/provider/opencode.ts`; provider auth plugins under `packages/opencode/src/plugin/` and `packages/core/src/plugin/provider/`
- **Function or symbol:** `Account.login`; `poll`; `refreshToken`; `fetchUser`; `fetchOrgs`; provider OAuth/device-code handlers
- **Destination or URL source:** User/account server URL and default `https://console.opencode.ai`; OpenAI (`auth.openai.com`, `chatgpt.com`), GitHub/Copilot, xAI, DigitalOcean, Snowflake, GitLab, and other provider-specific authorization/token/API hosts
- **Trigger condition:** Login/account commands, token expiry, organization/config reads, or provider authentication/model discovery.
- **Build time or runtime:** Runtime
- **Already disabled by `OPENCODE_ENTERPRISE_MODE`:** **No.** Built-in auth plugins load unless other independent plugin flags are set.
- **Recommended enterprise treatment:** **disable**
- **Risk and notes:** The future internal vLLM endpoint should use locally supplied credentials/configuration and must not reuse public provider login flows. Token refresh can happen later than login and therefore needs a low-level guard.

### EGR-24: Provider inference and model discovery

- **Category:** Provider network access
- **Source file:** `packages/opencode/src/provider/provider.ts`; `packages/opencode/src/session/llm/native-runtime.ts`; `packages/core/src/session/runner/model.ts`; built-in provider plugins
- **Function or symbol:** `resolveSDK`; provider `options.fetch`; `LLMNativeRuntime.stream`; provider SDK factories and discovery callbacks
- **Destination or URL source:** `model.api.url`, provider/config `baseURL`, models.dev catalog URLs, environment-derived cloud endpoints, or defaults embedded in bundled AI SDK packages. Hardcoded examples include Azure Cognitive Services, Google Vertex, DigitalOcean, Snowflake, GitLab, GitHub Copilot, xAI, and OpenCode gateways.
- **Trigger condition:** Selecting/listing some providers or executing a model turn; some plugins discover models before inference.
- **Build time or runtime:** Runtime
- **Already disabled by `OPENCODE_ENTERPRISE_MODE`:** **No.**
- **Recommended enterprise treatment:** **restrict to allowlist** containing exactly the future configured internal vLLM origin and required path set
- **Risk and notes:** This is the one future permitted egress class, but current destination selection is too broad and can be influenced by remote catalog/config. Validate scheme, hostname/IP, port, redirects, DNS resolution, and every retry/streaming/WebSocket transport. Reject all other providers rather than merely hiding them in UI.

### EGR-25: OpenAI provider WebSocket transport

- **Category:** WebSocket provider access
- **Source file:** `packages/opencode/src/plugin/openai/ws.ts`; `packages/opencode/src/plugin/openai/ws-pool.ts`; `packages/opencode/src/plugin/openai/codex.ts`
- **Function or symbol:** `connectResponsesWebSocket`; `OpenAIWebSocketPool`; Codex fetch override
- **Destination or URL source:** OpenAI/Codex response endpoint converted to WebSocket URL
- **Trigger condition:** Experimental WebSockets are enabled, and pre-release channels may enable them by default through `experimentalWebSocketsEnabled`.
- **Build time or runtime:** Runtime
- **Already disabled by `OPENCODE_ENTERPRISE_MODE`:** **No.**
- **Recommended enterprise treatment:** **disable**
- **Risk and notes:** A future vLLM allowance should start with required HTTP(S) streaming only. Do not accidentally allow public `wss:` through an HTTP-only origin check.

### EGR-26: Server web UI upstream proxy

- **Category:** Server HTTP proxy / hardcoded runtime URL
- **Source file:** `packages/opencode/src/server/shared/ui.ts`
- **Function or symbol:** `serveUIEffect`; `UI_UPSTREAM`; `upstreamURL`
- **Destination or URL source:** `https://app.opencode.ai`
- **Trigger condition:** Server serves a UI request and the embedded generated UI cannot be loaded, or `OPENCODE_DISABLE_EMBEDDED_WEB_UI` is true.
- **Build time or runtime:** Runtime
- **Already disabled by `OPENCODE_ENTERPRISE_MODE`:** **No.**
- **Recommended enterprise treatment:** **disable** fallback; **keep** only embedded UI
- **Risk and notes:** Counterintuitively, the “disable embedded UI” flag selects the remote proxy path. Enterprise startup should fail closed if embedded assets are unavailable, and browser CSP should not contain `connect-src *` or unrestricted remote media sources.

### EGR-27: Remote workspace control plane and proxy

- **Category:** HTTP/WebSocket proxy and control-plane network access
- **Source file:** `packages/opencode/src/control-plane/workspace.ts`; `packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts`; `packages/opencode/src/server/routes/instance/httpapi/middleware/proxy.ts`
- **Function or symbol:** workspace event/sync operations; `proxyRemote`; `HttpApiProxy.http`; `HttpApiProxy.websocket`
- **Destination or URL source:** Remote workspace adapter `target.url` and headers
- **Trigger condition:** Experimental workspace resolves to a remote target, then sync, VCS, HTTP API, or WebSocket traffic is routed to it.
- **Build time or runtime:** Runtime
- **Already disabled by `OPENCODE_ENTERPRISE_MODE`:** **No.**
- **Recommended enterprise treatment:** **disable** remote targets; **keep** local workspace placement
- **Risk and notes:** This is a generic authenticated proxy to an adapter-provided origin. It must not share an allowlist intended only for model inference.

### EGR-28: App/CLI/TUI connections to an OpenCode server

- **Category:** Direct fetch, EventSource, and WebSocket client transport
- **Source file:** `packages/cli/src/commands/handlers/api.ts`; `packages/cli/src/tui.ts`; `packages/tui/src/context/sdk.tsx`; `packages/tui/src/context/editor.ts`; `packages/app/src/context/server.tsx`; `packages/app/src/components/terminal.tsx`; `packages/desktop/src/renderer/index.tsx`
- **Function or symbol:** API handler fetches; SDK event stream; editor/terminal WebSockets; platform fetch
- **Destination or URL source:** Selected/stored server URL. Defaults are loopback or in-process, but users can configure HTTP(S)/WS(S) remote servers.
- **Trigger condition:** Attach mode, saved remote server, API CLI command, event subscription, terminal, or editor connection.
- **Build time or runtime:** Runtime
- **Already disabled by `OPENCODE_ENTERPRISE_MODE`:** **No.**
- **Recommended enterprise treatment:** **restrict to allowlist** of loopback/in-process transports only
- **Risk and notes:** Loopback traffic is acceptable and required. Validate resolved host addresses to prevent aliases, DNS rebinding, or redirects from turning an apparently local URL into outbound traffic.

### EGR-29: Desktop changelog, media, links, and WSL installers

- **Category:** Desktop-specific telemetry/content/update-adjacent behavior and child-process downloads
- **Source file:** `packages/app/src/context/highlights.tsx`; `packages/app/src/entry.tsx`; `packages/desktop/src/renderer/index.tsx`; `packages/desktop/src/main/wsl/runtime.ts`; app/menu/help components
- **Function or symbol:** `HighlightsProvider.start`; notification icons; `installWslDistro`; `installWslOpencode`; `platform.openLink`
- **Destination or URL source:** `https://opencode.ai/changelog.json`, changelog-provided image/video URLs, OpenCode favicon URLs, documentation/support/feedback links, Windows WSL web download, and `curl -fsSL https://opencode.ai/install`
- **Trigger condition:** Version changes with release notes enabled; notifications; user opens help/support; user installs WSL/distro/OpenCode from desktop onboarding.
- **Build time or runtime:** Runtime
- **Already disabled by `OPENCODE_ENTERPRISE_MODE`:** **No.**
- **Recommended enterprise treatment:** **disable** remote content/install actions; **keep** local icons/help and already installed WSL sidecars
- **Risk and notes:** Opening an external browser still initiates a network action from the running product workflow. WSL installation and OpenCode bootstrap are explicit runtime downloading and must be absent or clearly blocked.

### EGR-30: Git, GitHub integration, IDE extension installation, and arbitrary shell commands

- **Category:** Child-process network and package-manager execution
- **Source file:** `packages/core/src/git.ts`; `packages/opencode/src/worktree/index.ts`; `packages/opencode/src/cli/cmd/github.handler.ts`; `packages/opencode/src/cli/cmd/pr.ts`; `packages/opencode/src/ide/index.ts`; `packages/opencode/src/tool/shell.ts`; `packages/core/src/tool/bash.ts`
- **Function or symbol:** `Git.clone`; `Git.fetch`; `Worktree.reset`; GitHub agent fetch/push/API helpers; IDE `--install-extension`; `ShellTool.run`; `BashTool`
- **Destination or URL source:** Configured Git remotes; GitHub and `api.opencode.ai`; extension marketplace selected by the IDE; arbitrary destinations selected by commands such as `curl`, `wget`, `ssh`, `git`, `npm`, `bun`, `pip`, or user scripts
- **Trigger condition:** Worktree reset/sync, GitHub/PR commands, IDE install command, or model/user invokes a shell tool.
- **Build time or runtime:** Runtime
- **Already disabled by `OPENCODE_ENTERPRISE_MODE`:** **No.**
- **Recommended enterprise treatment:** **disable** networked integration/install operations; **restrict to allowlist** of local commands only; add OS-level egress denial
- **Risk and notes:** Command parsing and permission prompts cannot prove that a process is network-free. Shell scripts, interpreters, installed tools, Git hooks, plugins, LSPs, and local MCP can all bypass application HTTP wrappers. A process/container firewall is required as defense in depth if arbitrary local execution remains.

## Hardcoded and configurable destination inventory

The following runtime destination families were found in production code. This list intentionally omits inert schema/documentation strings and loopback base URLs used only to parse paths.

| Destination family | Examples / source | Runtime use | Enterprise disposition |
| --- | --- | --- | --- |
| OpenCode public services | `models.dev`, `opncd.ai`, `console.opencode.ai`, `app.opencode.ai`, `opencode.ai/install`, `opencode.ai/changelog.json`, `api.opencode.ai` | Catalog, sharing, account/config, UI proxy, update/bootstrap, release notes, GitHub integration | Disable |
| npm/package metadata | `NpmConfig.registry`, default `registry.npmjs.org`, registry tarball URLs | Plugins, provider SDKs, config dependencies, formatters, LSPs, upgrades | Allow at build time; disable at runtime |
| Release/package ecosystems | GitHub API/releases/raw, Homebrew formula API, Chocolatey API, Scoop manifest, Go modules, RubyGems, dotnet tools, Eclipse, JetBrains, HashiCorp | Updates, ripgrep, LSPs, TUI parsers, WSL/IDE helpers | Allow at build time; disable at runtime |
| Search services | `mcp.exa.ai`, `search.parallel.ai` | Websearch | Disable |
| Arbitrary user/config URLs | webfetch URL, MCP URL, instruction URL, skill URL, account URL, remote config URL, remote server URL, remote workspace target | Multiple HTTP/SSE/WebSocket paths | Disable, except loopback OpenCode transport |
| Provider APIs and auth | Provider/model `baseURL`, SDK defaults, OpenAI, Azure, Google, AWS, GitHub Copilot, xAI, DigitalOcean, Snowflake, GitLab, and other catalog endpoints | Login, discovery, inference, streaming | Reject all except one future exact internal vLLM allowlist |
| Telemetry | OTLP endpoint environment variable; build-time Sentry DSN | Logs, traces, errors | Disable |
| External browser links/media | docs, support, feedback, OAuth, changelog media, notification icons | User-initiated browser or renderer fetch | Disable or replace with local content |

Hardcoded `http://localhost`, `http://127.0.0.1`, `http://opencode.internal`, and derived local server URLs are not outbound by themselves. They should be retained only where binding and resolution are guaranteed local. `$schema` values in JSON files are metadata; OpenCode does not fetch them in the audited paths, although an external editor may do so outside the OpenCode process.

## Build-time and development access

The following are allowed and should remain unchanged:

- Workspace `package.json` dependency declarations and `bun.lock`.
- npm registry configuration used by developer/CI `bun install` or packaging.
- SDK generation, bundling, signing, Electron packaging, and release-upload scripts.
- Build-time acquisition of assets that are verified and embedded in the final enterprise artifact.
- CI calls to GitHub, package registries, signing/notarization services, or release systems.

Some files contain both allowed build-time configuration and prohibited runtime consequences. In particular, `packages/desktop/electron-builder.config.ts` may contact GitHub only indirectly during packaging, which is allowed, but it also embeds a GitHub update feed consumed by `electron-updater` at runtime, which must be disabled. Likewise, a build-time Sentry DSN becomes a runtime export destination and must not be present in an enterprise artifact.

No recommendation in this audit requires changing registry URLs, dependency declarations, lockfiles, build scripts, or normal development/CI installation behavior.

## Generic transport and transitive-code caveats

The production search found direct `fetch`, Effect `HttpClient`, WebSocket, SSE, child-process, Git, and package-manager paths. Static source review cannot enumerate every destination inside provider SDKs, Electron updater, OpenTUI parser loading, npm Arborist, LSP binaries, plugins, shell commands, or MCP subprocesses. Those components can create sockets without using OpenCode's HTTP helpers.

Therefore, feature guards are necessary but not sufficient. The enterprise runtime should also run with an OS/container egress policy that denies all destinations except the resolved internal vLLM address and denies DNS except the controlled resolver needed for that address. Tests should instrument `fetch`, Effect HTTP clients, WebSocket constructors, and child-process launches, but the deployment firewall remains the final control.

## Prioritized implementation plan

Each step should be a small, separately reviewed change with focused tests.

1. **Define one enterprise runtime policy surface.** Derive runtime flags from `OPENCODE_ENTERPRISE_MODE` in one place, expose an exact internal-vLLM endpoint configuration, and document fail-closed URL/redirect/DNS rules. Do not yet change package registries or build tooling.
2. **Close bypasses in already covered features.** Guard `ModelsDev.fetchAndWrite`/`refresh`, manual upgrade commands and `Installation` network/install methods, share URL import, and desktop updater startup/timer/IPC.
3. **Stop runtime package installation centrally.** Make `Npm.add`, `Npm.install`, `Npm.which` fallback, Arborist reify, plugin palette/CLI install, and dynamic provider installation fail with a clear enterprise error. Keep normal development and CI installation untouched.
4. **Disable remote content tools.** Do not register webfetch/websearch; reject remote instructions, remote skills, remote config/well-known config, sharing imports, and remote UI fallback. Keep local files and embedded UI.
5. **Disable MCP and remote workspace transports.** Block remote MCP, local MCP subprocess launch, OAuth/debug MCP commands, remote workspace sync, and HTTP/WebSocket proxy targets. Keep local workspace execution.
6. **Eliminate runtime tooling downloads.** Make enterprise mode imply a complete no-download LSP policy, close unguarded `Npm.which` paths, package or require `rg`, bundle TUI parser/query assets, and disable formatter/LSP installers. Add an offline startup/tool smoke test.
7. **Disable telemetry and public authentication.** Force OTLP and Sentry exporters off, preserve local logs/Crashpad only, and disable account, OAuth, public provider discovery, release notes, remote icons/media, help links, WSL bootstrap, and IDE extension installation.
8. **Restrict inference to internal vLLM.** Reject every provider except the approved bundled OpenAI-compatible/vLLM adapter. Validate the final request URL after substitutions and redirects; apply the same policy to streaming and any WebSocket path.
9. **Constrain process escape hatches.** In enterprise mode deny network-capable Git/GitHub operations and package-manager/install commands. Decide whether shell, plugins, local MCP, LSP, and user startup commands are disabled or run inside an OS sandbox with network denied.
10. **Add an egress backstop and regression suite.** Run CLI, TUI, server, and desktop offline with socket/DNS logging; assert zero non-loopback attempts before a model call and exactly the allowlisted vLLM destination during one. Repeat tests with redirects, proxy environment variables, IPv4/IPv6, DNS rebinding candidates, and malicious config/plugin inputs.

## Reproduction commands and search patterns

Run from the repository root. The exclusions reduce generated, test, documentation, localization, and SVG/schema noise; repeat without exclusions when investigating a specific hit.

```sh
# Existing enterprise coverage and requested feature flags
rg -n "OPENCODE_ENTERPRISE_MODE|OPENCODE_DISABLE_AUTOUPDATE|OPENCODE_DISABLE_MODELS_FETCH|OPENCODE_DISABLE_SHARE" packages

# Direct fetch and Effect HTTP clients
rg -n --glob '*.{ts,tsx,js,mjs,cjs}' --glob '!**/*.test.*' --glob '!**/test/**' \
  '\bfetch\s*\(|Bun\.fetch|HttpClientRequest\.(get|post|put|patch|delete)|HttpClient|FetchHttpClient' \
  packages/core/src packages/opencode/src packages/tui/src packages/cli/src packages/server/src packages/app/src packages/desktop/src

# WebSocket, SSE, EventSource, and proxy transports
rg -n --glob '*.{ts,tsx,js,mjs,cjs}' --glob '!**/*.test.*' \
  'new WebSocket|WebSocket\(|EventSource|SSEClientTransport|StreamableHTTPClientTransport|makeWebSocket|proxyRemote' \
  packages/core/src packages/opencode/src packages/tui/src packages/cli/src packages/server/src packages/app/src packages/desktop/src

# Runtime installers, package managers, download helpers, and child processes
rg -n --glob '*.{ts,tsx,js,mjs,cjs}' --glob '!**/*.test.*' \
  'Npm\.(add|install|which)|npmSvc\.install|Arborist|reify|\b(download|install)\b|curl\b|wget\b|Process\.(run|spawn)|ChildProcess\.make|Bun\.spawn' \
  packages/core/src packages/opencode/src packages/tui/src packages/cli/src packages/app/src packages/desktop/src

# Hardcoded runtime URL candidates
rg -n --glob '*.{ts,tsx,js,mjs,cjs}' --glob '!**/*.test.*' --glob '!**/test/**' \
  --glob '!**/i18n/**' --glob '!**/generated/**' --glob '!**/generated-effect/**' --glob '!**/*.txt' --glob '!**/*.md' \
  'https?://' \
  packages/core/src packages/opencode/src packages/tui/src packages/cli/src packages/server/src packages/app/src packages/desktop/src

# Telemetry and crash reporting
rg -n -i --glob '!**/*.test.*' \
  'sentry|telemetry|opentelemetry|OTEL|crash(report|lytics)|posthog|segment|amplitude|datadog|honeycomb|mixpanel' \
  packages/*/src

# Feature-specific traces
rg -n 'models\.dev|ShareNext|PluginLoader|resolvePluginTarget|StreamableHTTPClientTransport|webfetch|websearch|fetchRemoteJson|SkillDiscovery|disableLspDownload|electron-updater' \
  packages/core/src packages/opencode/src packages/tui/src packages/app/src packages/desktop/src

# Verify the documentation diff
git diff --check
git status --short
```

## Application-owned outbound policy status

OpenCode-owned application egress is now guarded in enterprise mode by the shared policy in
`packages/core/src/network/outbound-policy.ts` and by invocation-time checks at the provider inference, remote
workspace, HTTP/WebSocket proxy, CLI attach, embedded-web, desktop, and browser client boundaries. Server-side
egress is limited to the separately validated `OPENCODE_ENTERPRISE_VLLM_BASE_URL` inference path. Desktop clients
retain access to their managed sidecar and loopback OpenCode servers; enterprise browser clients retain same-origin
and explicit loopback OpenCode communication. RFC1918 addresses are not treated as trusted merely because they look
internal.

This is an application-owned transport boundary, not a complete process sandbox. Arbitrary shell commands and
arbitrary child processes can create sockets without passing through JavaScript `fetch`, Effect HTTP clients, or the
OpenCode URL policy. OS or network-namespace firewall enforcement remains mandatory for a hard zero-egress
guarantee. The next hardening step is to constrain shell/process execution and add deployment-level DNS and network
egress enforcement. Until that work is complete, this fork must not be described as fully network-contained.

## Audit limitations

This audit is source-based and does not claim that the list of transitive destinations inside third-party SDKs is exhaustive. It deliberately classifies any destination chosen by third-party runtime code as unsafe unless the enterprise implementation can prove it is constrained. Dynamic plugin code, shell commands, child processes, environment proxies, DNS, redirects, and native Electron components require runtime testing and deployment-level controls in addition to source changes.
