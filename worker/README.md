# Alphie API — Cloudflare Worker

Production backend. Same endpoints as `backend/server.js` (used for local dev);
both import the shared logic in `backend/lib/core.js`.

| Concern | Local (`backend/server.js`) | Worker (`worker/src/index.js`) |
|---------|-----------------------------|--------------------------------|
| TTS audio cache | `backend/tts-cache/` on disk | Cloudflare Cache API (per data center, 30 days) |
| Rate limits | `express-rate-limit` | `[[ratelimits]]` bindings in `wrangler.toml` |
| CORS | `FRONTEND_URL` / localhost | `ALLOWED_ORIGINS` var |
| Secrets | `backend/.env` | `wrangler secret put` |

The full-reading MP3 download is assembled in the browser
(`src/lib/audioDownload.ts`) from `/api/tts` calls, so neither backend keeps
download jobs in memory.

## Local test

```bash
cd worker
npm install
npx wrangler dev --env-file ../backend/.env   # http://localhost:8787
```

## Deploy

```bash
cd worker
npx wrangler login
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put AZURE_SPEECH_KEY      # optional: Azure Neural voices
npx wrangler deploy                           # prints https://alphie-api.<subdomain>.workers.dev
```

Then on Vercel set `VITE_API_URL` to the Worker URL (no trailing slash) and
redeploy the frontend. If the frontend moves to another domain, add it to
`ALLOWED_ORIGINS` in `wrangler.toml` and redeploy the Worker.

`API_SECRET` is optional, but the frontend sends no `Authorization` header
today, so leave it unset unless that changes.
