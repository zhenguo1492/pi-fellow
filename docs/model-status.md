# Models: status bar, favorites, and provider filtering

## Model status bar

Files: `src/providers/model-status.ts` (`ModelStatusTracker`), `src/pi/providerUsage.ts` (`ProviderUsageTracker`), `src/webview/modelStatus.ts`.

- Shown at the top of the session (styled like the Bot view header), fed by the `modelStatus` `ServerMessage`; hidden in Bot view.
- Content: model · context usage · 5h / 7d subscription quota of the current provider (warning color at ≥90%, error color at 100%). Clicking expands context, session tokens, and each quota window's reset time.
- Quota sources:
  - omp: `omp usage --json --provider <id>`.
  - pi: reads the OAuth token from `~/.pi/agent/auth.json` and calls Anthropic `/api/oauth/usage`, ChatGPT `wham/usage`, and Antigravity `retrieveUserQuotaSummary` directly (distinguishing the Gemini pool from the Claude/GPT pool). Tokens are not refreshed; an expired token is reported.
- Refresh: immediately on model switch, throttled to 30 s on `agent_end`, and polled every 5 minutes while idle.

## Model picker and favorites

- The model chip below the composer (`src/webview/modelPicker.ts`) lists only favorite models (`oh-my-pi-chater.favoriteModels`).
- Favorites are toggled with the ☆ button in the model QuickPick (command `selectModel`, the switch button at the right of the model status bar).

## Only logged-in providers

`readLoggedInProviders` (`src/pi/loggedInProviders.ts`) keeps only providers that have been `/login`-ed in the model list:

- pi: top-level keys of `~/.pi/agent/auth.json`.
- omp: reads enabled `auth_credentials` rows from `~/.omp/agent/agent.db` via `node:sqlite`; without `node:sqlite`, falls back to RPC `get_login_providers`.

`oh-my-pi-chater.showAllModels` disables the filter.
