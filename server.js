const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const API_URL = "https://api.football-data.org/v4";

async function footballData(endpoint) {
  if (!API_TOKEN) {
    throw new Error("FOOTBALL_DATA_TOKEN is not configured in Render");
  }

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

  return data;
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

    let home = 40;
    let draw = 30;
    let away = 30;

    if (homeScore !== null && homeScore !== undefined &&
        awayScore !== null && awayScore !== undefined) {
      if (homeScore > awayScore) {
        home = 100;
        draw = 0;
        away = 0;
      } else if (homeScore === awayScore) {
        home = 0;
        draw = 100;
        away = 0;
      } else {
        home = 0;
        draw = 0;
        away = 100;
      }
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
          name: finished
            ? homeScore === awayScore
              ? "Draw"
              : homeScore > awayScore
                ? match.homeTeam.name
                : match.awayTeam.name
            : "Undetermined"
        },
        advice: finished
          ? "Result based on the final score"
          : "Pre-match prediction model not yet available",
        percent: {
          home: finished ? `${home}%` : "N/A",
          draw: finished ? `${draw}%` : "N/A",
          away: finished ? `${away}%` : "N/A"
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
