const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const API_URL = "https://api.football-data.org/v4";
const apiCache = new Map();
const pendingRequests = new Map();

async function footballData(endpoint) {
  if (!API_TOKEN) {
    throw new Error("FOOTBALL_DATA_TOKEN is not configured in Render");
  }

  const cacheKey = endpoint;
  const cached = apiCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  if (pendingRequests.has(cacheKey)) {
    return pendingRequests.get(cacheKey);
  }

  const request = (async () => {
    const response = await fetch(API_URL + endpoint, {
      headers: {
        "X-Auth-Token": API_TOKEN
      }
    });

    const text = await response.text();
    let data;

    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }

    if (!response.ok) {
      throw new Error(
        data.message || "Football-data.org request failed: " + response.status
      );
    }

    const cacheDuration = endpoint.startsWith("/matches?")
      ? 10 * 60 * 1000
      : 30 * 60 * 1000;

    apiCache.set(cacheKey, {
      data,
      expiresAt: Date.now() + cacheDuration
    });

    return data;
  })();

  pendingRequests.set(cacheKey, request);

  try {
    return await request;
  } finally {
    pendingRequests.delete(cacheKey);
  }
}  

function convertMatch(match) {
  const statusMap = {
    TIMED: "NS",
    SCHEDULED: "NS",
    IN_PLAY: "LIVE",
    LIVE: "LIVE",
    PAUSED: "HT",
    FINISHED: "FT",
    POSTPONED: "PST",
    SUSPENDED: "SUSP",
    CANCELLED: "CANC",
    AWARDED: "AWD"
  };

  return {
    fixture: {
      id: match.id,
      date: match.utcDate,
      timestamp: Math.floor(Date.parse(match.utcDate) / 1000),
      status: {
        short: statusMap[match.status] || match.status,
        long: match.status
      }
    },
    league: {
      id: match.competition?.id,
      name: match.competition?.name || "Football",
      country: match.area?.name || "",
      logo: match.competition?.emblem || "",
      round: match.matchday
        ? "Matchday " + match.matchday
        : ""
    },
    teams: {
      home: {
        id: match.homeTeam?.id,
        name: match.homeTeam?.name || "Home team",
        logo: match.homeTeam?.crest || "",
        winner: match.score?.winner === "HOME_TEAM"
      },
      away: {
        id: match.awayTeam?.id,
        name: match.awayTeam?.name || "Away team",
        logo: match.awayTeam?.crest || "",
        winner: match.score?.winner === "AWAY_TEAM"
      }
    },
    goals: {
      home: match.score?.fullTime?.home ?? null,
      away: match.score?.fullTime?.away ?? null
    }
  };
}

app.get("/", (req, res) => {
  res.json({
    app: "FootyPredict",
    status: "online",
    provider: "Football-data.org"
  });
});

app.get("/api/fixtures", async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({
        error: "Use the date format YYYY-MM-DD"
      });
    }

    const startDate = new Date(date + "T00:00:00Z");
    const endDate = new Date(startDate);
    endDate.setUTCDate(endDate.getUTCDate() + 7);

    const dateFrom = startDate.toISOString().slice(0, 10);
    const dateTo = endDate.toISOString().slice(0, 10);

    const data = await footballData(
      "/matches?dateFrom=" +
      encodeURIComponent(dateFrom) +
      "&dateTo=" +
      encodeURIComponent(dateTo)
    );

    res.json((data.matches || []).map(convertMatch));
  } catch (error) {
    console.error("Fixtures error:", error.message);
    res.status(502).json({
      error: error.message
    });
  }
});
app.get("/api/predictions/:fixture", async (req, res) => {
  try {
    const fixtureId = Number(req.params.fixture);

    if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
      return res.status(400).json({ error: "Invalid fixture ID" });
    }

    const data = await footballData(`/matches/${fixtureId}`);
    const match = data.match || data;

    if (!match.homeTeam || !match.awayTeam) {
      return res.status(404).json({ error: "Match not found" });
    }

    const homeScore = match.score?.fullTime?.home;
    const awayScore = match.score?.fullTime?.away;
    const finished = match.status === "FINISHED";

    let home = 0;
let draw = 0;
let away = 0;

let predictionWinner = "Prediction unavailable";
let predictionAvailable = false;

if (!finished) {
  try {
    async function getTeamStrength(teamId) {
      const result = await footballData(
        `/teams/${teamId}/matches?status=FINISHED&limit=10`
      );

      if (!result || !Array.isArray(result.matches)) {
        return null;
      }

      const games = result.matches
        .filter(game =>
          game.status === "FINISHED" &&
          game.score?.fullTime?.home != null &&
          game.score?.fullTime?.away != null &&
          (
            game.homeTeam.id === teamId ||
            game.awayTeam.id === teamId
          )
        )
        .sort(
          (a, b) =>
            new Date(b.utcDate) - new Date(a.utcDate)
        )
        .slice(0, 10);

      if (games.length < 5) {
        return null;
      }

      let goalsScored = 0;
      let goalsConceded = 0;
      let points = 0;

      for (const game of games) {
        const isHome = game.homeTeam.id === teamId;

        const scored = isHome
          ? game.score.fullTime.home
          : game.score.fullTime.away;

        const conceded = isHome
          ? game.score.fullTime.away
          : game.score.fullTime.home;

        goalsScored += scored;
        goalsConceded += conceded;

        if (scored > conceded) {
          points += 3;
        } else if (scored === conceded) {
          points += 1;
        }
      }

      return {
        attack: goalsScored / games.length,
        defence: goalsConceded / games.length,
        pointsPerGame: points / games.length
      };
    }

    const [homeStats, awayStats] = await Promise.all([
      getTeamStrength(match.homeTeam.id),
      getTeamStrength(match.awayTeam.id)
    ]);

    if (homeStats && awayStats) {
      const expectedHome = Math.max(
        0.15,
        (homeStats.attack + awayStats.defence) / 2 + 0.20
      );

      const expectedAway = Math.max(
        0.15,
        (awayStats.attack + homeStats.defence) / 2
      );

      function poisson(goals, expected) {
        let probability = Math.exp(-expected);

        for (let i = 1; i <= goals; i++) {
          probability *= expected / i;
        }

        return probability;
      }

      let pHome = 0;
      let pDraw = 0;
      let pAway = 0;

      for (let h = 0; h <= 10; h++) {
        for (let a = 0; a <= 10; a++) {
          const probability =
            poisson(h, expectedHome) *
            poisson(a, expectedAway);

          if (h > a) {
            pHome += probability;
          } else if (h === a) {
            pDraw += probability;
          } else {
            pAway += probability;
          }
        }
      }

      const total = pHome + pDraw + pAway;

      if (total > 0 && Number.isFinite(total)) {
        home = Math.round((pHome / total) * 100);
        draw = Math.round((pDraw / total) * 100);
        away = 100 - home - draw;

        predictionWinner =
          home >= draw && home >= away
            ? match.homeTeam.name
            : draw >= home && draw >= away
              ? "Draw"
              : match.awayTeam.name;

        predictionAvailable = true;
      }
    }
  } catch (error) {
    console.error(
      "Prediction calculation failed:",
      error.message
    );
  }
} else if (homeScore != null && awayScore != null) {
  // For a completed match, show the actual result.
  // This is NOT a prediction.
  if (homeScore > awayScore) {
    predictionWinner = match.homeTeam.name;
  } else if (awayScore > homeScore) {
    predictionWinner = match.awayTeam.name;
  } else {
    predictionWinner = "Draw";
  }

  predictionAvailable = true;
}

    res.json({
      fixture: {
        id: match.id,
        date: match.utcDate,
        status: match.status
      },
      teams: {
        home: { name: match.homeTeam.name },
        away: { name: match.awayTeam.name }
      },
      predictions: {
        winner: {
  name: predictionWinner
},
        advice: finished
  ? "Result based on the final score"
  : predictionAvailable
    ? "Statistical prediction based on recent team performance"
    : "Prediction unavailable: insufficient match data",percent: {
  home: `${home}%`,
  draw: `${draw}%`,
  away: `${away}%`
       }
      }
    });
  } catch (error) {
    console.error("Predictions error:", error.message);
    res.status(502).json({
      error: "Unable to load match information"
    });
  }
});
app.listen(PORT, "0.0.0.0", () => {
  console.log("FootyPredict server running on port " + PORT);
});
