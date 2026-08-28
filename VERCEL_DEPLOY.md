# God's Eye View — Vercel Deployment Guide

## Prerequisites

- Node.js 24.x ([download](https://nodejs.org))
- A [Vercel account](https://vercel.com) (free)
- A [Google Cloud account](https://console.cloud.google.com) (required — $0 for ~1,000 sessions/month)
- Git (to push to GitHub for automatic deploys)

---

## Step 1 — Get Your API Keys

### 🔴 Required: Google Maps API Key

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project (or use existing)
3. Go to **APIs & Services → Library** and enable:
   - **Map Tiles API** (for the photorealistic 3D globe)
   - **Places API (New)** (for nearby places + voice search)
4. Go to **APIs & Services → Credentials → Create Credentials → API Key**
5. Click **Restrict Key**:
   - Under **Application restrictions**: select **HTTP referrers**
   - Add: `https://your-project-name.vercel.app/*`
   - Under **API restrictions**: restrict to Map Tiles API + Places API (New)
6. Copy the key — you'll need it in Step 3

**Cost:** First 1,000 3D tile sessions/month are free. Each session = up to 3 hours of rendering. Solo use almost never exceeds the free tier.

### 🟡 Optional Keys (get any or all)

| Key | Where to get | What it unlocks |
|-----|-------------|-----------------|
| **Cesium ion** | [ion.cesium.com](https://ion.cesium.com) → Access Tokens | Bing satellite imagery, Cesium terrain |
| **OpenAI** | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | Voice control + HUD AI summaries |
| **OpenSky OAuth** | [opensky-network.org](https://opensky-network.org) → Account → API | Higher aircraft rate limits |
| **NASA FIRMS** | [firms.modaps.eosdis.nasa.gov/api/map_key](https://firms.modaps.eosdis.nasa.gov/api/map_key/) | Live active fire layer |
| **TomTom** | [developer.tomtom.com](https://developer.tomtom.com) | Live traffic flow tiles |
| **AISStream** | [aisstream.io](https://aisstream.io) → Dashboard | Live ship positions (⚠️ see note below) |

> **⚠️ AISStream on Vercel:** AISStream requires a persistent WebSocket connection that serverless functions don't support. The ships layer will appear as "connecting" on Vercel. For full AIS vessel support, deploy on [Railway](https://railway.app) or [Render](https://render.com) which support always-on Node.js servers — no code changes needed.

---

## Step 2 — Install Vercel CLI

```bash
npm install -g vercel
vercel login
```

---

## Step 3 — Deploy

### Option A: Deploy from CLI (quickest)

```bash
# Inside the gods-eye-view-main/ folder:
vercel

# Follow the prompts:
# - Link to existing project? No → create new
# - Project name: gods-eye-view (or anything you like)
# - Override build settings? No (vercel.json handles it)
```

### Option B: Deploy from GitHub (recommended for updates)

1. Push this folder to a GitHub repo
2. Go to [vercel.com/new](https://vercel.com/new)
3. Import your GitHub repo
4. Vercel auto-detects `vercel.json` — no settings to change
5. Click **Deploy**

---

## Step 4 — Add Environment Variables

1. Go to your project in the [Vercel Dashboard](https://vercel.com/dashboard)
2. Click **Settings → Environment Variables**
3. Add each variable from `.env.vercel` that you have keys for:

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_MAPS_API_KEY` | ✅ Yes | 3D globe + Places API |
| `CESIUM_ION_TOKEN` | Optional | Bing imagery + terrain |
| `OPENAI_API_KEY` | Optional | Voice + HUD AI |
| `OPENSKY_AUTH_MODE` | Optional | Set to `anon` to start |
| `OPENSKY_CLIENT_ID` | Optional | OpenSky OAuth |
| `OPENSKY_CLIENT_SECRET` | Optional | OpenSky OAuth |
| `FIRMS_MAP_KEY` | Optional | Live fire layer |
| `TOMTOM_API_KEY` | Optional | Live traffic tiles |
| `AISSTREAM_API_KEY` | Optional | Ship positions (serverless limitation applies) |
| `VITE_AIS_LIVE_API_URL` | Optional | Set to `/api/ais-live` |
| `VITE_AIS_LIVE_MAX_ROWS` | Optional | Default: `12000` |

4. After adding variables, click **Redeploy** (from the Deployments tab) to rebuild with the new env vars

---

## Step 5 — Verify

Open your Vercel URL and check:

| Layer | How to verify | Expected |
|-------|--------------|---------|
| **3D Globe** | Loads on open | Photorealistic Earth |
| **Aircraft** | Click the plane icon | Live aircraft appear |
| **Satellites** | Click satellite icon | Orbiting objects |
| **Fires** | Click fire icon | Active fire detections (needs FIRMS key) |
| **Traffic** | Click traffic icon | Color-coded flow (needs TomTom key) |
| **Voice** | Click mic icon | Connects (needs OpenAI key) |

Check **DevTools → Network** for `/api/*` calls. `200` = working, `503` = missing env var, `401`/`403` = wrong key.

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Blank globe / black screen | Missing `GOOGLE_MAPS_API_KEY` | Add the key in Vercel settings, redeploy |
| `403` on Google APIs | Key restriction too strict | Add your Vercel URL to HTTP referrers in Google Cloud |
| Aircraft layer empty | OpenSky rate-limited (anon) | Set `OPENSKY_AUTH_MODE=oauth` and add OAuth credentials |
| Ships always "connecting" | AISStream WebSocket + serverless | Use Railway/Render for full AIS support |
| Voice mic doesn't connect | Missing `OPENAI_API_KEY` | Add key, redeploy |
| Fires layer "KEY REQUIRED" | Missing `FIRMS_MAP_KEY` | Get free key from NASA FIRMS |
| Build fails | Node version mismatch | Set Node 24.x in Vercel: Settings → General → Node.js Version |

---

## Node Version

This project requires Node.js ≥ 24.14.0. Set it in Vercel:
**Project Settings → General → Node.js Version → 24.x**

---

## Updating

```bash
# After making changes:
vercel --prod

# Or push to GitHub if connected — auto-deploys on every push.
```

---

## Security Notes

- `GOOGLE_MAPS_API_KEY` and `CESIUM_ION_TOKEN` are **intentionally exposed to the browser** (needed for 3D tiles). Restrict them with HTTP referrer restrictions in Google Cloud / Cesium ion.
- All other keys (`OPENAI_API_KEY`, `TOMTOM_API_KEY`, etc.) stay **server-side only** in the `/api/` functions and are never sent to the browser.
- Set budget alerts in Google Cloud (Billing → Budgets & Alerts) and OpenAI (Platform → Settings → Limits) as a billing backstop.
