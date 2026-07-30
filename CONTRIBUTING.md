# Contributing

Contributions are welcome.

1. Fork the repository and create a focused branch.
2. Keep runtime state, logs, credentials, and model transcripts out of commits.
3. Run `npm run check`, `npm test`, and `npm run pack:dry`.
4. Describe behavior changes and safety implications in the pull request.

RunMux defaults to read-only execution. Changes that broaden tool access, enable writes, or alter command execution must include focused tests and clear documentation.
