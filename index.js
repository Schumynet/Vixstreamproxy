// index.js

const express   = require("express");
const axios     = require("axios");
const fetch     = require("node-fetch");
const http      = require("http");
const https     = require("https");
const puppeteer = require("puppeteer");

const app  = express();
const PORT = process.env.PORT || 10000;

// ─── Middleware per JSON body parsing ────────────────────────────────────────
app.use(express.json());

// ─── Cataloghi VixSrc ────────────────────────────────────────────────────────
let availableMovies   = [];
let availableTV       = [];
let availableEpisodes = [];

async function loadCatalogs() {
  try {
    const [moviesRes, tvRes, episodesRes] = await Promise.all([
      axios.get("https://vixsrc.to/api/list/movie?lang=it"),
      axios.get("https://vixsrc.to/api/list/tv?lang=it"),
      axios.get("https://vixsrc.to/api/list/episode?lang=it")
    ]);
    availableMovies   = moviesRes.data;
    availableTV       = tvRes.data;
    availableEpisodes = episodesRes.data;
    console.log("✅ Cataloghi VixSrc caricati");
  } catch (err) {
    console.error("❌ Errore caricamento cataloghi VixSrc:", err.message);
  }
}

// Carica al boot e ricarica ogni 30 minuti
loadCatalogs();
setInterval(loadCatalogs, 30 * 60 * 1000);

// ─── Endpoint per contenuti disponibili ──────────────────────────────────────
app.get("/home/available", (req, res) => {
  const combined = [
    ...availableMovies.map(id   => ({ tmdb_id: id, type: "movie"  })),
    ...availableTV.map(id       => ({ tmdb_id: id, type: "tv"     })),
    ...availableEpisodes.map(id => ({ tmdb_id: id, type: "episode" }))
  ];
  res.json(combined);
});

// 🔁 Funzione helper: costruisce l'URL del proxy
function getProxyUrl(originalUrl) {
  return `https://vixstreamproxy.onrender.com/stream?url=${encodeURIComponent(originalUrl)}`;
}

// 🔍 Estrazione playlist con regex
async function vixsrcPlaylist(tmdbId, seasonNumber, episodeNumber) {
  const targetUrl = (seasonNumber !== undefined)
    ? `https://vixsrc.to/tv/${tmdbId}/${seasonNumber}/${episodeNumber}/?lang=it`
    : `https://vixsrc.to/movie/${tmdbId}?lang=it`;

  const response = await axios.get(targetUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Referer":    "https://vixsrc.to"
    }
  });

  const text = response.data;
  const m = new RegExp(
    "token': '(.+)',\\n[ ]+'expires': '(.+)',\\n.+\\n.+\\n.+url: '(.+)',\\n[ ]+}\\n[ ]+window.canPlayFHD = (false|true)"
  ).exec(text);
  if (!m) return null;

  const [ , token, expires, rawUrl, canPlayFHD ] = m;
  const playlistUrl = new URL(rawUrl);
  const b = playlistUrl.searchParams.get("b");

  playlistUrl.searchParams.set("token", token);
  playlistUrl.searchParams.set("expires", expires);
  if (b !== null)      playlistUrl.searchParams.set("b", b);
  if (canPlayFHD === "true") playlistUrl.searchParams.set("h", "1");

  return playlistUrl.toString();
}

// 🧠 Fallback Puppeteer per estrazione in pagina
async function extractWithPuppeteer(url) {
  let playlistUrl = null;
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);

    page.on("request", request => {
      const reqUrl = request.url();
      if (!playlistUrl && reqUrl.includes("playlist") && reqUrl.includes("rendition=")) {
        playlistUrl = reqUrl;
      }
      request.continue();
    });

    await page.goto(url, { timeout: 60000 });
    await page.waitForTimeout(10000);
  } catch (e) {
    // Ignora errori di estrazione
  } finally {
    await browser.close();
  }

  return playlistUrl;
}

// 🎬 Endpoint HLS per film
app.get("/hls/movie/:id", async (req, res) => {
  const { id } = req.params;
  let playlistUrl = await vixsrcPlaylist(id);
  if (!playlistUrl) {
    playlistUrl = await extractWithPuppeteer(`https://vixsrc.to/movie/${id}`);
  }
  if (!playlistUrl) {
    return res.status(404).json({ error: "Flusso non trovato" });
  }
  res.json({ url: getProxyUrl(playlistUrl) });
});

// 📺 Endpoint HLS per serie TV
app.get("/hls/show/:id/:season/:episode", async (req, res) => {
  const { id, season, episode } = req.params;
  let playlistUrl = await vixsrcPlaylist(id, season, episode);
  if (!playlistUrl) {
    playlistUrl = await extractWithPuppeteer(`https://vixsrc.to/tv/${id}/${season}/${episode}`);
  }
  if (!playlistUrl) {
    return res.status(404).json({ error: "Flusso non trovato" });
  }
  res.json({ url: getProxyUrl(playlistUrl) });
});

// 🔁 Proxy universale per playlist e segmenti
app.get("/stream", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).send("Missing url");
  }

  const isM3U8 = /\.(m3u8|mpd)$/.test(targetUrl) || targetUrl.includes("playlist");
  let responded = false;

  const sendError = (status, msg) => {
    if (!responded) {
      responded = true;
      res.status(status).send(msg);
    }
  };

  if (isM3U8) {
    try {
      const proxyRes = await fetch(targetUrl, {
        headers: {
          "Referer":    "https://vixsrc.to",
          "User-Agent": "Mozilla/5.0"
        },
        timeout: 10000
      });
      let text = await proxyRes.text();
      const base = targetUrl.split("/").slice(0, -1).join("/");

      // Riscrivi URI e segmenti
      text = text
        .replace(/URI="([^"]+)"/g, (_, uri) => {
          const abs = uri.startsWith("http")
            ? uri
            : uri.startsWith("/")
              ? `https://vixsrc.to${uri}`
              : `${base}/${uri}`;
          return `URI="${getProxyUrl(abs)}"`;
        })
        .replace(/^([^#\r\n].+\.(ts|key|vtt))$/gm, (m) => {
          return getProxyUrl(`${base}/${m}`);
        });

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.send(text);
      responded = true;
    } catch (err) {
      console.error("Errore proxy m3u8:", err.message);
      sendError(500, "Errore proxy m3u8");
    }
  } else {
    try {
      const urlObj = new URL(targetUrl);
      const client = urlObj.protocol === "https:" ? https : http;

      const proxyReq = client.get(targetUrl, {
        headers: {
          "Referer":    "https://vixsrc.to",
          "User-Agent": "Mozilla/5.0",
          "Accept":     "*/*",
          "Connection": "keep-alive"
        },
        timeout: 10000
      }, proxyRes => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
        responded = true;
      });

      proxyReq.on("timeout", () => {
        proxyReq.destroy();
        sendError(504, "Timeout");
      });

      proxyReq.on("error", err => {
        console.error("Errore proxy stream:", err.message);
        sendError(500, "Errore proxy media");
      });

      req.on("close", () => {
        proxyReq.destroy();
        responded = true;
      });
    } catch (err) {
      console.error("URL invalido:", err.message);
      sendError(400, "URL invalido");
    }
  }
});

// 🧠 Salvataggio progresso di riproduzione
app.post("/progress/save", (req, res) => {
  const {
    ip,
    tmdbId,
    contentType,
    season,
    episode,
    currentTime,
    duration,
    title
  } = req.body;

  if (!tmdbId || currentTime == null || duration == null) {
    return res.status(400).json({ error: "Dati incompleti" });
  }

  console.log("📥 Progresso ricevuto:", {
    ip,
    tmdbId,
    contentType,
    season,
    episode,
    currentTime,
    duration,
    title,
    timestamp: new Date().toISOString()
  });

  res.json({ success: true });
});

// 🚀 Avvio server
app.listen(PORT, () => {
  console.log(`🎬 VixStream HLS proxy in ascolto su http://0.0.0.0:${PORT}`);
});