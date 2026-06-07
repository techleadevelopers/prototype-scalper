# BingX Dashboard

Standalone Vite frontend for the BingX execution backend.

## Local development

```powershell
pnpm install
pnpm dev
```

Configure:

```env
VITE_API_URL=http://localhost:8080
```

## Vercel

Import this directory as its own Git repository, or select
`artifacts/bingx-dashboard` as the Vercel Root Directory.

Set the production environment variable:

```env
VITE_API_URL=https://futures-execution-engine-production.up.railway.app
```

The included `vercel.json` builds the Vite application and provides SPA
route fallback.

The Railway backend must use the final Vercel deployment origin:

```env
FRONTEND_URL=https://your-dashboard.vercel.app
NODE_ENV=production
```

Requests use credentials so the backend can maintain the BingX session.
