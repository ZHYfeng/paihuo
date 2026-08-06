# Changelog

This file records notable user-facing and maintainer-facing changes. The format follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are added when releases are tagged.

## Unreleased

### Added

- Reproducible frontend tooling through `package.json` and `package-lock.json`.
- `make` targets for build, test, race detection, frontend synchronization, and the full quality gate.
- GitHub CI, CodeQL, Dependabot, issue forms, and a pull-request checklist.
- Contribution, support, security, and community conduct documentation.
- `--version` and `--secure-cookie` runtime flags.

### Changed

- The default listen address is now `127.0.0.1:8080`; binding a non-loopback address without an access token is rejected.
- Session cookies use a cryptographically random nonce and complete HMAC signature.
- HTTP responses include a browser-security baseline, dynamic responses are not cached, and JSON request bodies are bounded and strictly parsed.
