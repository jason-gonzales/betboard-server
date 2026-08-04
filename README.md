# BetBoard Backend

Tiny server that holds your Odds API key privately, refreshes odds every 3
minutes, and serves cached data to everyone using your app. Your API key
never touches the frontend or your users' devices.

## Run it locally first (to make sure it works)

```bash
npm install
cp .env.example .env
# edit .env and paste in your real Odds API key
npm start
```

Then visit `http://localhost:3000/api/odds/mlb` in a browser — you should
see JSON with live MLB games.

## Deploy it somewhere real

You need this running on a server that's reachable from the internet 24/7 —
your laptop won't do once friends are using the app on their own phones.
**Render** is a good free option to start with:

1. Push this folder to a GitHub repo
2. Go to render.com → New → Web Service → connect that repo
3. Build command: `npm install`
4. Start command: `npm start`
5. Under Environment, add `ODDS_API_KEY` with your real key as the value
6. Deploy — Render gives you a public URL like `https://betboard-xyz.onrender.com`

Other solid options: Railway, Fly.io, or a small VPS if you want more
control. Any of them work the same way — set `ODDS_API_KEY` as an
environment variable there, never in code.

## Wire it into the app

Once deployed, take that URL and paste it into the `BACKEND_URL` constant
near the top of `BetBoardMobile.html`. That's the only change needed on
the frontend — no one using the app touches an API key, ever.

## A note on the free Render tier

Free-tier services on Render "spin down" after 15 minutes of no traffic
and take ~30-60 seconds to wake back up on the next request. Fine for
testing with friends; if that delay becomes annoying, a paid tier ($7/mo
ish) keeps it always-on.
