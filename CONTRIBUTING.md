# Contributing

Thanks for helping improve the A2A + A2UI Workbench.

## Local Setup

```bash
npm install
npm run dev
```

Run the validation suite before opening a pull request:

```bash
npm run lint
npm run test
npm run typecheck
npm run build
```

## Development Notes

- Keep the app generic to A2A and A2UI. Avoid vendor-specific defaults, branding, or protocol assumptions.
- Do not commit credentials, live endpoint secrets, `.env.local`, build output, or generated local review artifacts.
- Preserve the protocol inspector's raw evidence views when changing normalization behavior.
- Add focused tests for route parsing, redaction, security guardrails, and A2UI normalization changes.
- Treat `/api/a2a/stream` as a local proxy boundary. Any feature that broadens what it can fetch should include security tests and docs.

## Pull Request Checklist

- The change is scoped and described clearly.
- Tests cover the behavioral change.
- Documentation is updated when configuration, protocol behavior, or security posture changes.
- The full check suite passes.
