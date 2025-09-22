const express = require("express");
const puppeteer = require("puppeteer");
const axios = require("axios");

const app = express();

// 🔑 Chiave TMDB
const TMDB_KEY = "be78689897669066bef6906e501b0e10";

// 🔍 Ricerca contenuti
app.get("/search", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Parametro 'q' mancante" });

  try {
    const response = await axios.get("https://api.themoviedb.org/3/search/multi", {
      params: {
        api_key: TMDB_KEY,
        query,
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
    console.error("🔥 Errore TMDB:", err.message);
    res.status(500).json({ error: "Errore nella ricerca TMDB" });
  }
});

// 🎬 Endpoint per generare m3u8 da film
app.get("/hls/movie/:id", async (req, res) => {
  const id = req.params.id;
  const url = `https://vixsrc.to/movie/${id}`;
  await generateM3U8(url, res);
});

// 📺 Endpoint per generare m3u8 da serie TV
app.get("/hls/show/:id/:season/:episode", async (req, res) => {
  const { id, season, episode } = req.params;
  const url = `https://vixsrc.to/tv/${id}/${season}/${episode}`;
  await generateM3U8(url, res);
});

// 🧠 Funzione per generare playlist m3u8
async function generateM3U8(url, res) {
  const tsSegments = [];
  let encryptionKey = null;

  try {
    console.log("🌐 Navigazione verso:", url);

    const browser = await puppeteer.launch({
      headless: true,
      executablePath: puppeteer.executablePath(),
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer"
      ]
    });

    const page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on("request", request => {
      const reqUrl = request.url();

      if (reqUrl.endsWith(".ts")) {
        tsSegments.push(reqUrl);
        console.log("🎬 Segmento:", reqUrl);
      }

      if (reqUrl.includes("enc.key") && !encryptionKey) {
        encryptionKey = reqUrl;
        console.log("🔐 Chiave:", encryptionKey);
      }

      request.continue();
    });

    await page.goto(url, { timeout: 60000 });

    // ⏳ Aspetta iframe e clicca sul player
    await page.waitForSelector("iframe");
    const frameHandle = await page.$("iframe");
    const frame = await frameHandle.contentFrame();

    await frame.evaluate(() => {
      const selectors = [
        ".ad-overlay",
        ".close-ad",
        ".vix-close",
        ".videoAdUiSkipButton",
        "#dismiss-button"
      ];
      selectors.forEach(sel => {
        const el = document.querySelector(sel);
        if (el) el.click();
      });
    });

    try {
      await frame.waitForSelector("button, .vjs-big-play-button", { timeout: 10000 });
      await frame.click("button, .vjs-big-play-button");
      console.log("🖱️ Click sul player eseguito");
    } catch (err) {
      console.warn("⚠️ Nessun bottone cliccabile trovato");
    }

    await new Promise(resolve => setTimeout(resolve, 10000));
    await browser.close();

    if (tsSegments.length === 0) {
      console.warn("⚠️ Nessun segmento trovato");
      return res.status(404).json({ error: "Nessun flusso trovato" });
    }

    // 🧩 Costruisci la playlist m3u8
    let m3u8 = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n";

    if (encryptionKey) {
      m3u8 += `#EXT-X-KEY:METHOD=AES-128,URI="${encryptionKey}"\n`;
    }

    tsSegments.forEach(url => {
      m3u8 += "#EXTINF:10.0,\n" + url + "\n";
    });

    m3u8 += "#EXT-X-ENDLIST";

    res.type("application/vnd.apple.mpegurl").send(m3u8);
  } catch (err) {
    console.error("🔥 Errore Puppeteer:", err.message);
    res.status(500).json({ error: "Errore interno", debug: err.message });
  }
}

// 🚀 Avvio server
const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ VixStream attivo su porta ${PORT}`);
});