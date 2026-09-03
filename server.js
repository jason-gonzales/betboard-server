// BetBoard backend — holds the Odds API key server-side.
// Your app's users never see or need their own key; they all
// hit this server, which fetches from The Odds API on a timer
// and serves everyone the same cached result.

import express from "express";
import cors from "cors";
import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors()); // odds data is public info, no need to lock this down by origin

// Serve the app itself from this same server, at the root URL. This is
// what makes the app genuinely shareable — a real https:// page, not a
// local file, and not subject to Claude artifact sandboxing since it's
// not running inside claude.ai at all.
app.use(express.static(path.join(__dirname, "public")));

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

// ---- MLB Stats API (official, free, no key needed) — used for real
// team form and scoring trends. https://statsapi.mlb.com
let teamNameToId = null; // built once from the teams endpoint, rarely changes

async function loadTeamIds() {
  try {
    const res = await fetch("https://statsapi.mlb.com/api/v1/teams?sportId=1");
    const body = await res.json();
    teamNameToId = {};
    for (const t of body.teams) teamNameToId[t.name] = t.id;
    console.log(`Loaded ${Object.keys(teamNameToId).length} MLB team IDs.`);
  } catch (err) {
    console.error("Failed to load MLB team IDs:", err.message);
  }
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

// Pulls a team's last 5 completed games and turns them into the same
// shape the frontend already knows how to render: a W/L form string and
// a run-scored trend array. This is real data — no ATS/O-U here, since
// that needs historical odds we don't have access to.
async function computeTeamTrend(teamId) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 21); // look back 3 weeks to reliably catch 5 games
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=${teamId}&startDate=${fmtDate(start)}&endDate=${fmtDate(end)}`;
  const res = await fetch(url);
  const body = await res.json();
  const games = [];
  for (const day of body.dates || []) {
    for (const g of day.games) {
      if (g.status?.abstractGameState !== "Final") continue;
      const isHome = g.teams.home.team.id === teamId;
      const mine = isHome ? g.teams.home : g.teams.away;
      const theirs = isHome ? g.teams.away : g.teams.home;
      games.push({
        date: g.officialDate,
        won: mine.isWinner === true,
        runsFor: mine.score,
        runsAgainst: theirs.score,
      });
    }
  }
  games.sort((a, b) => a.date.localeCompare(b.date));
  const last5 = games.slice(-5);
  return {
    form: last5.map(g => (g.won ? "W" : "L")).join(""),
    record: `${last5.filter(g => g.won).length}-${last5.filter(g => !g.won).length}`,
    trend: last5.map((g, i) => ({ g: String(i - last5.length), runsFor: g.runsFor, runsAgainst: g.runsAgainst })),
  };
}

async function refreshTrends() {
  if (!teamNameToId) await loadTeamIds();
  const mlbGames = cache.mlb?.data || [];
  const teamNames = new Set();
  for (const g of mlbGames) { teamNames.add(g.home_team); teamNames.add(g.away_team); }
  const trends = {};
  for (const name of teamNames) {
    const id = teamNameToId?.[name];
    if (!id) continue;
    try {
      trends[name] = await computeTeamTrend(id);
    } catch (err) {
      console.error(`Trend fetch failed for ${name}:`, err.message);
    }
  }
  cache.trends = { data: trends, fetchedAt: Date.now() };
  console.log(`[trends] refreshed for ${Object.keys(trends).length} teams`);
}

// Finds the last 3 completed meetings between two teams, using MLB's
// free schedule endpoint (no historical-odds cost involved — this is
// just game results, not betting lines, so no ATS info here).
async function computeH2H(teamAId, teamBId) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 500); // ~1.5 seasons back, enough to usually catch a few meetings
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=${teamAId}&startDate=${fmtDate(start)}&endDate=${fmtDate(end)}`;
  const res = await fetch(url);
  const body = await res.json();
  const meetings = [];
  for (const day of body.dates || []) {
    for (const g of day.games) {
      if (g.status?.abstractGameState !== "Final") continue;
      const homeId = g.teams.home.team.id, awayId = g.teams.away.team.id;
      const isMatchup = (homeId === teamAId && awayId === teamBId) || (homeId === teamBId && awayId === teamAId);
      if (!isMatchup) continue;
      const homeScore = g.teams.home.score, awayScore = g.teams.away.score;
      if (typeof homeScore !== "number" || typeof awayScore !== "number") continue; // skip games with incomplete score data (e.g. suspended/oddly-reported entries)
      const homeWon = g.teams.home.isWinner === true;
      meetings.push({
        date: g.officialDate,
        homeTeam: g.teams.home.team.name,
        awayTeam: g.teams.away.team.name,
        note: `${homeWon ? g.teams.home.team.name : g.teams.away.team.name} won ${Math.max(homeScore, awayScore)}-${Math.min(homeScore, awayScore)}`,
      });
    }
  }
  meetings.sort((a, b) => b.date.localeCompare(a.date)); // most recent first
  return meetings.slice(0, 3).map(m => ({
    date: new Date(m.date).toLocaleDateString("en-US", { month: "short", year: "numeric" }),
    note: `${m.awayTeam} @ ${m.homeTeam} — ${m.note}`,
  }));
}

async function refreshH2H() {
  if (!teamNameToId) await loadTeamIds();
  const mlbGames = cache.mlb?.data || [];
  const h2h = {};
  for (const g of mlbGames) {
    const awayId = teamNameToId?.[g.away_team];
    const homeId = teamNameToId?.[g.home_team];
    if (!awayId || !homeId) continue;
    const key = `${g.away_team}__${g.home_team}`;
    try {
      h2h[key] = await computeH2H(awayId, homeId);
    } catch (err) {
      console.error(`H2H fetch failed for ${key}:`, err.message);
    }
  }
  cache.h2h = { data: h2h, fetchedAt: Date.now() };
  console.log(`[h2h] refreshed for ${Object.keys(h2h).length} matchups`);
}

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
  // Trends and H2H use MLB's own free API (no credit cost), so these are
  // safe to run every cycle regardless of Odds API credit status.
  try {
    await refreshTrends();
  } catch (err) {
    console.error("Trends refresh failed:", err.message);
  }
  try {
    await refreshH2H();
  } catch (err) {
    console.error("H2H refresh failed:", err.message);
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

app.get("/api/trends/mlb", (req, res) => {
  const entry = cache.trends;
  if (!entry) {
    return res.status(503).json({ error: "No trend data cached yet — try again in a few seconds." });
  }
  res.json({
    fetchedAt: entry.fetchedAt,
    ageSeconds: Math.round((Date.now() - entry.fetchedAt) / 1000),
    teams: entry.data,
  });
});

app.get("/api/h2h/mlb", (req, res) => {
  const entry = cache.h2h;
  if (!entry) {
    return res.status(503).json({ error: "No head-to-head data cached yet — try again in a few seconds." });
  }
  res.json({
    fetchedAt: entry.fetchedAt,
    ageSeconds: Math.round((Date.now() - entry.fetchedAt) / 1000),
    matchups: entry.data,
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
