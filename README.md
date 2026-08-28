# Claude Code Control Panel

Self-hosted Railway control panel. See `CLAUDE.md` for architecture and security decisions.

## Development

```bash
npm install
npm run typecheck
npm test
npm run dev
```

The server requires the variables in `.env.example`. Copy that file to `.env` for local development and fill in local-only values; never commit `.env`.
