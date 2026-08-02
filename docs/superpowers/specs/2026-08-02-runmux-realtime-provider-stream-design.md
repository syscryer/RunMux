# RunMux Real-Time Provider Stream Design

## Goal

Allow CodeM and other parent agents to consume provider events while a RunMux
child agent is still running. The first version optimizes for implementation
speed: RunMux forwards the active provider's native event stream unchanged,
and consumers select a parser based on the agent/provider type.

## Command Interface

Add an explicit `--stream` option to agent execution commands. Without this
option, RunMux retains its current final JSON/text behavior.

For the current Claude Code provider, stream mode replaces
`--output-format json` with:

```text
--output-format stream-json
--include-partial-messages
--forward-subagent-text
```

`--stream` and `--json` are mutually exclusive because they define different
stdout contracts.

## Data Flow

In stream mode, RunMux starts the provider using its native stream arguments.
Each provider stdout chunk is immediately written to RunMux stdout, and each
provider stderr chunk is immediately written to RunMux stderr. RunMux also
buffers both streams for its existing log and session bookkeeping.

RunMux does not wrap, normalize, merge, or filter provider stdout events. It
does not append the final answer or its own summary to stdout. RunMux
diagnostics continue to use stderr, so stdout remains a valid provider-native
JSONL stream for machine consumers.

After the process exits, RunMux parses the buffered stdout line by line. The
Claude adapter locates the final `result` event and extracts the result,
session id, and cost using the existing state model. This parsing is internal
and does not alter the forwarded bytes.

## Component Changes

- Option parsing recognizes and validates `--stream`.
- Provider invocation construction selects final or streaming output flags.
- Process execution accepts stdout and stderr chunk callbacks while preserving
  buffered output.
- Claude stream parsing resolves the final result event for state persistence,
  logs, and transcript display.
- Final answer printing becomes a no-op for stream stdout while retaining
  RunMux diagnostics on stderr.

The stream option is provider-neutral at the RunMux command boundary. Provider
specific arguments and result extraction remain inside the provider adapter
logic so future agent types can expose their native streams independently.

## Error Handling

- Provider output already received remains visible if the provider later
  fails.
- Provider failures, timeouts, and process start errors are reported through
  stderr and a non-zero RunMux exit status; RunMux does not synthesize an
  stdout event.
- Malformed JSONL lines are forwarded unchanged and ignored by internal result
  extraction.
- A zero provider exit without a final result event is treated as incomplete.
  RunMux returns failure and does not overwrite persistent agent session state.
- Interrupted or failed runs retain their logs but do not replace the last
  successful session state.

Because the stream is intentionally unfiltered, it may contain any public
reasoning or thinking event exposed by the provider. RunMux does not create or
supplement hidden reasoning content.

## Compatibility

- Commands without `--stream` preserve the current `--output-format json`
  invocation, stdout, stderr, logging, and state behavior.
- `once --stream` remains ephemeral and does not persist agent state.
- The same forwarding mechanism applies to native Windows and WSL child
  processes.
- Existing log files remain readable. Transcript loading accepts either one
  final JSON object or a provider-native JSONL stream.

## Verification

Implementation verification covers:

- Claude streaming arguments and `--stream`/`--json` validation.
- Receipt of the first event before provider process completion.
- Byte-for-byte stdout forwarding without a duplicate final answer.
- Final result, session id, cost, log, and transcript extraction.
- State protection for provider failure and missing final events.
- Ephemeral `once` behavior.
- Windows and WSL invocation paths.
- Regression coverage for all existing non-stream commands.
- CLI help, README, and installed RunMux skill examples.
- One live Claude Code stream run after automated tests pass.
