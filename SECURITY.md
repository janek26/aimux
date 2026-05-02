# Security Policy

## Reporting a Vulnerability

Please do not open public issues for suspected vulnerabilities.

If this project is hosted on GitHub, report vulnerabilities through GitHub's private vulnerability reporting when available. Otherwise, contact the maintainers privately and include:

- A description of the issue and its impact.
- Steps to reproduce or a minimal proof of concept.
- Affected versions or commits, if known.
- Any logs or config snippets with secrets removed.

## Secrets and Local Config

aimux config can contain LLM provider tokens, MCP authorization headers, OAuth access tokens, and refresh tokens. Real `.aimux.yml` files must stay local and are ignored by git.

Use `.aimux.example.yml` for examples and documentation. If a real token is accidentally exposed, revoke or rotate it immediately.
