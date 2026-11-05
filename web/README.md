# PrintSheet Web

React + TypeScript + Vite shell for the review-driven workbench.

Phase 0 includes the visual shell and a live API/database health check. The
crop tool, brush editor, wizard, batch grid and packing preview are Phase 1
track D, built against the frozen OpenAPI contract.

```bash
npm install
npm run dev
npm run build
npm run lint
```

The Vite dev server proxies `/healthz` and `/api` to
`VITE_API_PROXY_TARGET` (default `http://localhost:8080`). In Docker Compose the
target is `http://api:8080`.
