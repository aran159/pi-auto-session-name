# pi-auto-session-name

Global [pi](https://github.com/earendil-works/pi) extension that assigns concise display names to coding-agent sessions.

## Install

Install through Pi's Git package support:

```sh
pi install git:github.com/aran159/pi-auto-session-name
```

This extension requires a separately installed, enabled `pi-subagents` extension with runtime agent registration and structured delegation support.
It does not install or bundle another copy of `pi-subagents`.
Restart Pi or run `/reload`. The installed `pi-subagents` extension selects the naming model and resolves authentication.
If the integration is unavailable, automatic naming leaves the session unchanged and `/auto-name` reports the missing requirement.

## Behavior

- Existing names set through `/name` or `--name` are preserved.
- `/auto-name` explicitly regenerates a name and asks before replacing an existing one.
- Ticket IDs found in the conversation are normalized and prefixed to the generated title, for example `DEMO-123: Improve sample workflow`.
- Naming input is bounded. Tool output, thinking blocks, images, system context, abandoned branches, and pre-compaction history are excluded.
- Short runs are named after `agent_settled`; runs still active after `activeNamingDelayMs` are named in the background from the conversation available so far.
- Automatic duplicate requests share a configurable cooldown; changed conversation excerpts and explicit `/auto-name` retries remain eligible immediately.
- Active timers and requests are cancelled on rename or session shutdown.

## How the name is generated

Automatic naming uses a hybrid trigger while the session has no existing name and `automatic` is enabled. Short runs are named after `agent_settled`, once Pi has finished tools, retries, compaction retries, and queued continuations. When a run remains active for `activeNamingDelayMs` (60 seconds by default), naming starts in the background from the conversation available at that point, even if no assistant text has been finalized yet. If the run settles before the timer, the timer is cancelled. `/auto-name` runs the same process explicitly and can replace an existing name after confirmation.

A name is generated from a deliberately small conversation excerpt:

1. Starting at the active session leaf, the extension follows parent entries on the active branch only. Abandoned branches are never included.
2. It sends user and assistant text. Tool results, tool calls, thinking blocks, images, custom messages, system prompts, and session metadata are excluded.
3. Text is whitespace-normalized and bounded by `maxMessageChars` per message.
4. The earliest `maxMessages` useful user/assistant messages are retained. This favors the original task and initial outcome rather than later incidental details.
5. Traversal stops at the latest compaction checkpoint. Neither its summary nor earlier history is sent. Naming waits for a new user message if none follows that checkpoint.
6. The final excerpt is bounded again by `maxConversationChars`. Settled and manual naming require at least one user and one assistant message; the active-run timeout requires only a user message.

The extension registers a dedicated runtime agent named `session-namer` through the installed `pi-subagents` event API.
It delegates the bounded excerpt with fresh context and no explicit model or thinking override.
The agent has no tools, inherited instructions, discovered skills, memory, or ambient extensions.
A zero-tool budget blocks any unexpected tool call. The delegation disables Intercom and optional artifacts.
The naming prompt asks the model to:

- return only a title, without markdown or explanation;
- use the conversation's language;
- use roughly three to eight words when practical;
- describe the concrete task or outcome;
- preserve useful project names, ticket IDs, and technical terms;
- avoid generic names such as `Coding Session` or `Help Request`.

The model response is then normalized locally:

- only the first non-empty response line is used;
- Markdown headings, bullets, `Title:`/`Titel:`, matching quotation marks, control characters, and trailing punctuation are removed;
- whitespace is normalized;
- the result is capped at `maxTitleChars` and rejected if it is empty or shorter than three characters.

When `ticketPrefix` is enabled, the extension searches the bounded excerpt locally for the first ticket ID matching a generic form such as `DEMO-123`. It uppercases the ID, removes a duplicate occurrence from the model title, and produces a final name such as:

```text
DEMO-123: Improve sample workflow
```

No second model request is used for ticket handling or normalization. Identical automatic excerpts are fingerprinted locally and subject to `cooldownMs`, preventing duplicate requests after failures or repeated settled events. A changed excerpt or explicit `/auto-name` remains eligible immediately.

## Privacy

User and assistant text can contain secrets, file contents, or information inserted by another extension.
The extension does not guarantee secret removal. Never use naming for sessions whose conversation text must stay private.
Set `automatic` to `false` to disable automatic requests. Do not run `/auto-name` for sensitive sessions.
Requests use the provider selected by `pi-subagents`, which can differ from the session provider. Its retention policy still applies.
`pi-subagents` owns child execution and local run/session retention. `artifacts: false` disables optional artifacts, not every possible local record.
Host-required child extensions can still apply. Review their behavior before use with sensitive conversations.
The naming prompt treats excerpts as untrusted data, but prompt instructions are not a security boundary.
Provider errors are not displayed because their messages can contain sensitive request details.

## Model selection

There is no built-in naming model. `pi-subagents` selects the model through its normal settings:

1. A matching `subagents.agentOverrides.session-namer.model` setting.
2. `subagents.defaultModel` when no agent override selects a model.
3. The current parent session model when neither setting selects one.

Provider-scoped model overrides and model scope restrictions also apply.
The agent omits its thinking setting, so the operator's `pi-subagents` thinking defaults and overrides apply.
A small, inexpensive model with little or no thinking is sufficient for this task.

Merge a model override into `~/.pi/agent/settings.json`:

```json
{
  "subagents": {
    "agentOverrides": {
      "session-namer": {
        "model": "PROVIDER/MODEL_ID",
        "thinking": "off"
      }
    }
  }
}
```

Use a model ID that your Pi registry provides, authenticate its provider, and run `/reload`.
`/subagents-models session-namer` shows the live mapping after registration.
Do not define a file-based agent named `session-namer`; it can collide with this runtime agent.
The runtime agent keeps its tool and context restrictions; settings can change its model, provider preference, fast mode, and thinking.

## Configuration

The extension follows Pi's extension-specific configuration convention: defaults in the package, a global file below Pi's `extensions` directory, and an optional trusted project override.

### Global configuration

Create:

```txt
~/.pi/agent/extensions/auto-session-name.json
```

This applies to every project. If `PI_CODING_AGENT_DIR` is set, its `extensions/auto-session-name.json` replaces this path.
`PI_AUTO_SESSION_NAME_CONFIG` can select a different global file.

### Project configuration

A trusted project may override individual global settings in:

```txt
<project>/.pi/auto-session-name.json
```

Project configuration is read only when `ctx.isProjectTrusted()` is true. Untrusted projects cannot change naming behavior or data limits.
The installed `pi-subagents` extension separately applies its trusted project settings for model selection.

### Precedence

Configuration is merged in this order, from lowest to highest priority:

1. built-in safe defaults
2. `~/.pi/agent/extensions/auto-session-name.json`
3. trusted `<project>/.pi/auto-session-name.json`
4. supported environment overrides

An absent file is normal. Invalid JSON or values keep the previous/default value and emit a startup warning without preventing Pi from loading.

### Example

```json
{
  "timeoutMs": 30000,
  "automatic": true,
  "activeNamingDelayMs": 60000,
  "cooldownMs": 300000,
  "maxMessages": 6,
  "maxMessageChars": 3000,
  "maxConversationChars": 12000,
  "maxTitleChars": 80,
  "ticketPrefix": true
}
```

See [`config.example.json`](config.example.json) for the complete default configuration.

### Options

| Option | Default | Purpose |
|---|---:|---|
| `timeoutMs` | `30000` | Naming delegation deadline; cancellation also occurs locally |
| `automatic` | `true` | Automatically name unnamed sessions |
| `activeNamingDelayMs` | `60000` | Name a still-running session after this delay; minimum 1000 ms |
| `cooldownMs` | `300000` | Cooldown for an identical failed/empty automatic request |
| `maxMessages` | `6` | Maximum user/assistant excerpts |
| `maxMessageChars` | `3000` | Maximum normalized characters per excerpt |
| `maxConversationChars` | `12000` | Maximum total naming context |
| `maxTitleChars` | `80` | Maximum resulting title length |
| `ticketPrefix` | `true` | Detect and normalize ticket IDs locally |

Provider/model authentication remains the installed `pi-subagents` extension's and Pi's responsibility.
This extension does not read credentials or call a model provider directly.

### Migration from direct model requests

These old settings and their corresponding environment overrides are ignored with a startup warning:
`provider`, `model`, `reasoning`, `temperature`, `maxTokens`, `maxRetries`, `maxRetryDelayMs`, and `cacheRetention`.
Move model and thinking choices to `subagents.agentOverrides.session-namer` in Pi settings.
Provider request options now follow `pi-subagents` and Pi behavior; the delegation API does not expose the old per-request controls.
`maxTitleChars` still bounds the final title, but this extension no longer sets a 96-token response limit.

### Environment overrides

Following the focused override pattern used by `pi-commandcode-provider`, these variables support tests, local experiments, and declarative launch environments:

- `PI_AUTO_SESSION_NAME_CONFIG` — replace the global config path
- `PI_AUTO_SESSION_NAME_TIMEOUT_MS`
- `PI_AUTO_SESSION_NAME_AUTOMATIC`
- `PI_AUTO_SESSION_NAME_ACTIVE_NAMING_DELAY_MS`
- `PI_AUTO_SESSION_NAME_COOLDOWN_MS`
- `PI_AUTO_SESSION_NAME_MAX_MESSAGES`
- `PI_AUTO_SESSION_NAME_MAX_MESSAGE_CHARS`
- `PI_AUTO_SESSION_NAME_MAX_CONVERSATION_CHARS`
- `PI_AUTO_SESSION_NAME_MAX_TITLE_CHARS`
- `PI_AUTO_SESSION_NAME_TICKET_PREFIX`

Boolean values accept `true`, `false`, `1`, and `0`.

## Update and remove

Update installed Pi packages:

```sh
pi update git:github.com/aran159/pi-auto-session-name
```

Remove the extension:

```sh
pi remove git:github.com/aran159/pi-auto-session-name
```

## Troubleshooting

### `Cannot find module './config.ts'`

The installed package tree is older than `src/index.ts`. Reinstall/update the package or rebuild the declarative Home Manager configuration. Verify that this file exists:

```sh
ls ~/.pi/agent/packages/pi-auto-session-name/src/config.ts
```

Until fixed, Pi can start without extensions using:

```sh
pi -ne
```

## Development

```sh
npm ci --ignore-scripts
npm run check
```

This runs type checking, focused behavior/configuration/delegation tests, and reproducible `--expose-gc` retained-heap and request-gate measurements.
Tests do not call a live model.

To also validate against an installed compiled `pi-subagents` package:

```sh
PI_SUBAGENTS_TEST_PACKAGE_DIR="$HOME/.pi/agent/npm/node_modules/pi-subagents" npm run check
```

This checks real runtime registration and request validation without credentials or model requests.
