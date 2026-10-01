const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY;
const API_URL = "https://v3.football.api-sports.io";

async function apiFootball(endpoint) {
  if (!API_KEY) {
    throw new Error("API_FOOTBALL_KEY is not configured");
  }

  const response = await fetch(API_URL + endpoint, {
    headers: {
      "x-apisports-key": API_KEY
    }
  });

  if (!response.ok) {
    throw new Error("API-Football request failed");
  }

  const data = await response.json();

  if (data.errors && Object.keys(data.errors).length > 0) {
    throw new Error(JSON.stringify(data.errors));
  }

  return data.response || [];
}

app.get("/", (req, res) => {
  res.json({
    app: "FootyPredict",
    status: "online"
  });
});

app.get("/api/fixtures", async (req, res) => {
  try {
    const date =
      req.query.date ||
      new Date().toISOString().slice(0, 10);

    const fixtures = await apiFootball(
      "/fixtures?date=" + encodeURIComponent(date)
    );

    res.json(fixtures);
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

app.get("/api/predictions/:fixture", async (req, res) => {
  try {
    const predictions = await apiFootball(
      "/predictions?fixture=" +
      encodeURIComponent(req.params.fixture)
    );

    res.json(predictions);
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log("FootyPredict server running on port " + PORT);
});
