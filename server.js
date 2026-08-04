// BetBoard backend — holds the Odds API key server-side.
// Your app's users never see or need their own key; they all
// hit this server, which fetches from The Odds API on a timer
// and serves everyone the same cached result.

import express from "express";
import cors from "cors";
import "dotenv/config";

const app = express();
app.use(cors()); // odds data is public info, no need to lock this down by origin

const PORT = process.env.PORT || 3000;
const ODDS_API_KEY = process.env.ODDS_API_KEY;

if (!ODDS_API_KEY) {
  console.error("Missing ODDS_API_KEY in environment. Set it before starting the server.");
  process.exit(1);
}

// How often to refresh from The Odds API.
// IMPORTANT: The Odds API's free tier is 500 CREDITS/month, not 500 requests.
// Each call costs (markets × regions) credits. We request 3 markets in 1
// region = 3 credits per call. Refreshing every few minutes will burn the
// whole monthly budget in hours, not weeks — keep this interval generous.
const REFRESH_MS = 20 * 60 * 1000; // 20 minutes = ~72 cycles/day max if left awake nonstop

const SPORT_KEYS = {
  mlb: "baseball_mlb",
  // nba: "basketball_nba", // paused — NBA is offseason right now (0 games),
  //                        // no point spending credits on empty responses.
  //                        // Uncomment when the season is back.
  // nfl: "americanfootball_nfl", // needs a paid Odds API plan to unlock
};

// If we're getting close to the monthly credit limit, stop auto-refreshing
// so we don't silently burn the last of it — the cache just goes stale
// instead of erroring out mid-test.
const LOW_CREDIT_THRESHOLD = 20;
let creditsRemaining = null;
let refreshPaused = false;

// In-memory cache: { mlb: { data, fetchedAt }, nba: {...} }
const cache = {};

async function refreshSport(sportSlug) {
  if (refreshPaused) return;
  const sportKey = SPORT_KEYS[sportSlug];
  if (!sportKey) return;
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h,spreads,totals&oddsFormat=american&bookmakers=draftkings,fanduel,betmgm`;
  try {
    const res = await fetch(url);
    const remainingHeader = res.headers.get("x-requests-remaining");
    if (remainingHeader !== null) {
      creditsRemaining = Number(remainingHeader);
      if (creditsRemaining <= LOW_CREDIT_THRESHOLD && !refreshPaused) {
        refreshPaused = true;
        console.warn(`Only ${creditsRemaining} Odds API credits left — pausing auto-refresh until the monthly reset. Serving last cached data.`);
      }
    }
    if (!res.ok) {
      const body = await res.text();
      console.error(`[${sportSlug}] Odds API error ${res.status}:`, body);
      return;
    }
    const data = await res.json();
    cache[sportSlug] = { data, fetchedAt: Date.now() };
    console.log(`[${sportSlug}] refreshed — ${data.length} games, credits remaining: ${creditsRemaining}`);
  } catch (err) {
    console.error(`[${sportSlug}] fetch failed:`, err.message);
  }
}

async function refreshAll() {
  for (const sportSlug of Object.keys(SPORT_KEYS)) {
    await refreshSport(sportSlug);
  }
}

// Prime the cache on boot, then refresh on a timer.
refreshAll();
setInterval(refreshAll, REFRESH_MS);

app.get("/api/odds/:sport", (req, res) => {
  const sport = req.params.sport.toLowerCase();
  if (!SPORT_KEYS[sport]) {
    return res.status(404).json({ error: `Unsupported sport "${sport}". Try one of: ${Object.keys(SPORT_KEYS).join(", ")}` });
  }
  const entry = cache[sport];
  if (!entry) {
    return res.status(503).json({ error: "No data cached yet — try again in a few seconds." });
  }
  res.json({
    sport,
    fetchedAt: entry.fetchedAt,
    ageSeconds: Math.round((Date.now() - entry.fetchedAt) / 1000),
    games: entry.data,
  });
});

app.get("/health", (req, res) => res.json({
  ok: true,
  creditsRemaining,
  refreshPaused,
  refreshIntervalMinutes: REFRESH_MS / 60000,
}));

app.listen(PORT, () => {
  console.log(`BetBoard backend running on port ${PORT}`);
});
