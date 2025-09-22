const express = require("express");
const puppeteer = require("puppeteer");
const axios = require("axios");
const app = express();

// 🔍 SEARCH via TMDB
app.get("/search", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Parametro 'q' mancante" });

  const tmdbKey = "be78689897669066bef6906e501b0e10";

  try {
    const response = await axios.get(`https://api.themoviedb.org/3/search/multi`, {
      params: {
        api_key: tmdbKey,
        query: query,
        include_adult: false,
        language: "it-IT"
      }
    });

    const results = response.data.results
      .filter(item => item.media_type === "movie" || item.media_type === "tv")
      .map(item => ({
        id: item.id,
        type: item.media_type,
        title: item.title || item.name,
        poster: item.poster_path
          ? `https://image.tmdb.org/t/p/w500${item.poster_path}`
          : null
      }));

    res.json({ results });
  } catch (err) {
    console.error("Errore TMDB:", err.message);
    res.status(500).json({ error: "Errore nella ricerca TMDB" });
  }
});

// 🎬 MOVIE STREAM
app.get("/hls/movie/:id", async (req, res) => {
  const tmdbId = req.params.id;
  const url = `https://vixsrc.to/movie/${tmdbId}`;
  await extractStream(url, res);
});

// 📺 SHOW STREAM
app.get("/hls/show/:id/:season/:episode", async (req, res) => {
  const { id, season, episode } = req.params;
  const url = `https://vixsrc.to/tv/${id}/${season}/${episode}`;
  await extractStream(url, res);
});

// 🧠 Funzione comune per estrazione flusso
async function extractStream(url, res) {
  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer"
      ]
    });

    const page = await browser.newPage();
    let hlsUrl = null;

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      try {
        const reqUrl = request.url();
        if (reqUrl.includes(".m3u8") && !hlsUrl) {
          hlsUrl = reqUrl;
        }
        request.continue();
      } catch (err) {
        console.error("Errore nella richiesta:", err);
      }
    });

    console.log("Navigating to:", url);
    await page.goto(url, { timeout: 60000 });
    await page.waitForTimeout(5000);
    await browser.close();

    if (!hlsUrl) {
      return res.status(404).json({ error: "Nessun flusso trovato" });
    }

    res.json({ video: [{ label: "Auto", url: hlsUrl }] });
  } catch (err) {
    console.error("Errore interno:", err.message);
    res.status(500).json({ error: "Errore interno" });
  }
}

// 🚀 Porta dinamica per Render
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`FabioStream proxy attivo su porta ${PORT}`);
});