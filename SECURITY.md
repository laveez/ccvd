# Security Policy

## Reporting a Vulnerability

Please use [GitHub's private vulnerability reporting](https://github.com/laveez/ccvd/security/advisories/new). Do not open a public issue for a security problem.

You can expect an initial response within 48 hours.

## Supported Versions

Fixes go into the latest release. Update with `npx @laveez/ccvd@latest` or by updating the Claude Code plugin.

## What ccvd exposes

ccvd runs a local web server for its compare view and drives a headless Chromium that loads the two addresses you give it. The parts that matter for security:

- The server listens on `127.0.0.1` only.
- The WebSocket that controls the pages, and the image export, need the random token in the address ccvd prints. A new token is made for every run.
- Requests must carry a `Host` header of `127.0.0.1:<port>` or `localhost:<port>`, and the WebSocket an `Origin` from the same, which blocks other websites and DNS rebinding.
- The compared pages, and paths typed into the view, can only be `http` or `https` addresses.

The compared pages run in Chromium with your network access, as any page you open yourself would. Compare only sites you trust.
