# pi-auto-session-name

Global [pi](https://github.com/earendil-works/pi) extension that assigns a concise display name after the first settled agent run.

## Install

Install the published npm package through Pi's package manager:

```sh
pi install npm:pi-auto-session-name
```

Restart Pi or run `/reload`. The extension uses the configured naming provider/model; authenticate that provider through Pi as usual.

## Behavior

- Existing names set through `/name` or `--name` are preserved.
- `/auto-name` explicitly regenerates a name and asks before replacing an existing one.
- Ticket IDs found in the conversation are normalized and prefixed to the generated title, for example `DEMO-123: Improve sample workflow`.
- Naming input is bounded. Tool output, thinking blocks, images, system context, abandoned branches, and pre-compaction history are excluded.
- Automatic duplicate requests share a configurable cooldown; changed conversation excerpts and explicit `/auto-name` retries remain eligible immediately.
- Active requests are aborted on rename or session shutdown.

## How the name is generated

Automatic naming runs after an `agent_settled` event, once Pi has finished the initial agent run, including tools, retries, compaction retries, and queued continuations. It runs only while the session has no existing name and `automatic` is enabled. `/auto-name` runs the same process explicitly and can replace an existing name after confirmation.

A name is generated from a deliberately small conversation excerpt:

1. Starting at the active session leaf, the extension follows parent entries on the active branch only. Abandoned branches are never included.
2. It keeps only user and assistant text. Tool results, tool calls, thinking blocks, images, custom messages, system prompts, loaded instructions, file contents, and other session metadata are excluded.
3. Text is whitespace-normalized and bounded by `maxMessageChars` per message.
4. The earliest `maxMessages` useful user/assistant messages are retained. This favors the original task and initial outcome instead of later incidental details.
5. Traversal stops at the latest compaction checkpoint. Its bounded summary is included as earlier-session context, while the full pre-compaction history is not read or retained.
6. The final excerpt is bounded again by `maxConversationChars` and must contain at least one user and one assistant message.

The excerpt is sent as a single user request to the configured Pi provider/model. The naming prompt asks the model to:

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

## Configuration

The extension follows Pi's extension-specific configuration convention: defaults in the package, a global file below Pi's `extensions` directory, and an optional trusted project override.

### Global configuration

Create:

```txt
~/.pi/agent/extensions/auto-session-name.json
```

This applies to every project.

### Project configuration

A trusted project may override individual global settings in:

```txt
<project>/.pi/auto-session-name.json
```

Project configuration is read only when `ctx.isProjectTrusted()` is true. Untrusted projects cannot change the naming provider, model, request behavior, or data limits.

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
  "provider": "openai-codex",
  "model": "gpt-5.4-mini",
  "reasoning": "low",
  "maxTokens": 96,
  "timeoutMs": 30000,
  "maxRetries": 0,
  "maxRetryDelayMs": 60000,
  "cacheRetention": "none",
  "automatic": true,
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
| `provider` | `openai-codex` | Pi provider ID used for naming |
| `model` | `gpt-5.4-mini` | Model ID within the provider |
| `reasoning` | `low` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; Pi clamps unsupported levels |
| `temperature` | unset | Optional provider temperature from `0` to `2` |
| `maxTokens` | `96` | Maximum naming response tokens |
| `timeoutMs` | `30000` | Provider request timeout |
| `maxRetries` | `0` | Provider-level retry attempts |
| `maxRetryDelayMs` | `60000` | Maximum accepted provider retry delay |
| `cacheRetention` | `none` | `none`, `short`, or `long` |
| `automatic` | `true` | Automatically name unnamed sessions after `agent_settled` |
| `cooldownMs` | `300000` | Cooldown for an identical failed/empty automatic request |
| `maxMessages` | `6` | Maximum user/assistant excerpts |
| `maxMessageChars` | `3000` | Maximum normalized characters per excerpt |
| `maxConversationChars` | `12000` | Maximum total naming context |
| `maxTitleChars` | `80` | Maximum resulting title length |
| `ticketPrefix` | `true` | Detect and normalize ticket IDs locally |

Provider/model authentication remains Pi's responsibility. Configure or log in to the selected provider normally; the extension resolves credentials, headers, and provider-scoped environment through Pi's model registry.

### Environment overrides

Following the focused override pattern used by `pi-commandcode-provider`, these variables support tests, local experiments, and declarative launch environments:

- `PI_AUTO_SESSION_NAME_CONFIG` — replace the global config path
- `PI_AUTO_SESSION_NAME_PROVIDER`
- `PI_AUTO_SESSION_NAME_MODEL`
- `PI_AUTO_SESSION_NAME_REASONING`
- `PI_AUTO_SESSION_NAME_TEMPERATURE`
- `PI_AUTO_SESSION_NAME_MAX_TOKENS`
- `PI_AUTO_SESSION_NAME_TIMEOUT_MS`
- `PI_AUTO_SESSION_NAME_MAX_RETRIES`
- `PI_AUTO_SESSION_NAME_MAX_RETRY_DELAY_MS`
- `PI_AUTO_SESSION_NAME_CACHE_RETENTION`
- `PI_AUTO_SESSION_NAME_AUTOMATIC`
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
pi update --extensions
```

Remove the extension:

```sh
pi remove npm:pi-auto-session-name
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
npm install
npm run check
```

This runs type checking, focused behavior/configuration tests, and reproducible `--expose-gc` before/after retained-heap plus provider-attempt measurements.
