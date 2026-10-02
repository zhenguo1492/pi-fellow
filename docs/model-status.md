# Models: status bar, favorites, and provider filtering

## Model status bar

Files: `src/providers/model-status.ts` (`ModelStatusTracker`), `src/pi/providerUsage.ts` (`ProviderUsageTracker`), `src/webview/modelStatus.ts`.

- Shown at the top of the session (styled like the Bot view header), fed by the `modelStatus` `ServerMessage`; hidden in Bot view.
- Content: model · context usage · 5h / 7d subscription quota of the current provider (warning color at ≥90%, error color at 100%). Clicking expands context, session tokens (in · out · cost), cache (cumulative hit rate `cacheRead / (input + cacheRead + cacheWrite)` · read · write, when there were any; its own row, hit first, so the panel's edge does not cut it off), and each quota window's reset time.
- Quota sources:
  - omp: `omp usage --json --provider <id>`.
  - pi: reads the OAuth token from `~/.pi/agent/auth.json` and calls Anthropic `/api/oauth/usage`, ChatGPT `wham/usage`, and Antigravity `retrieveUserQuotaSummary` directly (distinguishing the Gemini pool from the Claude/GPT pool). The extension never refreshes tokens itself: a token expired or within a minute of expiry is fetched with `pi auth print-bearer-token --provider <id>` (pi ≥ 0.83), which refreshes it under pi's own lock and writes it back to `auth.json`. When that fails (older pi, a provider the auth command does not know such as the Antigravity plugin, a revoked refresh token), the expired token is reported.
- Refresh: immediately on model switch, throttled to 30 s on `agent_end`, and polled every 5 minutes while idle.

## Model picker and favorites

- The model chip below the composer (`src/webview/modelPicker.ts`) lists only favorite models (`oh-my-pi-chater.favoriteModels`).
- In the Bot view the same chip is the voice agent's, shown in light blue (`--voice-model-fg` in `tokens.css`, also on its list): it shows and sets `oh-my-pi-chater.voiceAgent.model`, never the worker's. Its list is the favorites, plus the chosen model when it is not one; left empty (the chat tab's model), the chip names the model the voice agent runs and no row is ticked. Only Settings → Voice → Voice agent → Model ("Same as the chat tab's model") sets it back to empty. The two are separate state in `modelPicker.ts` (`setPickerTarget` from `stateSync`; the voice side from each Bot view state's `engines.llm`), so a pick for one leaves the other. A pick posts `voiceAgent` `{ type: 'model' }`; the host saves the setting, and its change switches a running voice agent from its next reply.
- Favorites are toggled with the ☆ button in the model QuickPick (command `selectModel`, the switch button at the right of the model status bar).

## Only logged-in providers

`readLoggedInProviders` (`src/pi/loggedInProviders.ts`) keeps only providers that have been `/login`-ed in the model list:

- pi: top-level keys of `~/.pi/agent/auth.json`.
- omp: reads enabled `auth_credentials` rows from `~/.omp/agent/agent.db` via `node:sqlite`; without `node:sqlite`, falls back to RPC `get_login_providers`.

`oh-my-pi-chater.showAllModels` disables the filter.
