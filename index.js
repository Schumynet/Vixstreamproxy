const express   = require("express");
const axios     = require("axios");
const fetch     = require("node-fetch");
const http      = require("http");
const https     = require("https");
const puppeteer = require("puppeteer");

const app  = express();
const PORT = process.env.PORT || 10000;

const TMDB_API_KEY = process.env.TMDB_API_KEY || "be78689897669066bef6906e501b0e10";
const TMDB_BASE    = "https://api.themoviedb.org/3";
const IMAGE_BASE   = "https://image.tmdb.org/t/p";

app.use(express.json());

// ─── GENERI STATICI ───────────────────────────────────────────────────────────
const genres = [/* ... come nel tuo file originale ... */];
app.get("/genres", (req, res) => res.json(genres));
app.get("/genres/:id", (req, res) => {
  const genreId = parseInt(req.params.id, 10);
  const genre = genres.find(g => g.id === genreId);
  if (!genre) return res.status(404).json({ error: "Genere non trovato" });
  res.json(genre);
});

// ─── DISCOVER MOVIE & TV ──────────────────────────────────────────────────────
app.get("/discover/movie", async (req, res) => { /* ... */ });
app.get("/discover/tv", async (req, res) => { /* ... */ });

// ─── CATALOGHI VixSrc ─────────────────────────────────────────────────────────
let availableMovies = [], availableTV = [], availableEpisodes = [];
async function loadCatalogs() {
  try {
    const [mv, tv, ep] = await Promise.all([
      axios.get("https://vixsrc.to/api/list/movie?lang=it"),
      axios.get("https://vixsrc.to/api/list/tv?lang=it"),
      axios.get("https://vixsrc.to/api/list/episode?lang=it")
    ]);
    availableMovies   = mv.data;
    availableTV       = tv.data;
    availableEpisodes = ep.data;
    console.log("✅ Cataloghi VixSrc caricati");
  } catch (err) {
    console.error("❌ Errore caricamento cataloghi:", err.message);
  }
}
loadCatalogs();
setInterval(loadCatalogs, 30 * 60 * 1000);

app.get("/home/available", (req, res) => {
  const combined = [
    ...availableMovies.map(id => ({ tmdb_id: id, type: "movie" })),
    ...availableTV.map(id => ({ tmdb_id: id, type: "tv" })),
    ...availableEpisodes.map(id => ({ tmdb_id: id, type: "episode" }))
  ];
  res.json(combined);
});

// ─── METADATA ─────────────────────────────────────────────────────────────────
app.get("/metadata/movie/:id", async (req, res) => { /* ... */ });
app.get("/metadata/tv/:id", async (req, res) => { /* ... */ });
app.get("/metadata/tv/:tvId/season/:season/episode/:episode", async (req, res) => { /* ... */ });

// ─── HELPER URL PROXY ─────────────────────────────────────────────────────────
function getProxyUrl(originalUrl) {
  return `https://vixstreamproxy.onrender.com/stream?url=${encodeURIComponent(originalUrl)}`;
}

// ─── ESTRAZIONE PLAYLIST ─────────────────────────────────────────────────────
async function vixsrcPlaylist(tmdbId, season, episode) {
  const url = episode != null
    ? `https://vixsrc.to/tv/${tmdbId}/${season}/${episode}/?lang=it`
    : `https://vixsrc.to/movie/${tmdbId}?lang=it`;
  const resp = await axios.get(url, {
    headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://vixsrc.to" }
  });
  const txt = resp.data;
  const m = /token': '(.+)',\s*'expires': '(.+)',[\s\S]+?url: '(.+)',[\s\S]+?window.canPlayFHD = (false|true)/.exec(txt);
  if (!m) return null;
  const [, token, expires, raw, canFHD] = m;
  const playlist = new URL(raw);
  const b = playlist.searchParams.get("b");
  playlist.searchParams.set("token", token);
  playlist.searchParams.set("expires", expires);
  if (b != null) playlist.searchParams.set("b", b);
  if (canFHD === "true") playlist.searchParams.set("h", "1");
  return playlist.toString();
}

async function extractWithPuppeteer(url) {
  let pl = null;
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", req => {
      const u = req.url();
      if (!pl && u.includes("playlist") && u.includes("rendition=")) pl = u;
      req.continue();
    });
    await page.goto(url, { timeout: 60000 });
    await page.waitForTimeout(10000);
  } catch {}
  await browser.close();
  return pl;
}

async function parseQualities(m3u8Url) {
  try {
    const res = await fetch(m3u8Url, {
      headers: { "Referer": "https://vixsrc.to", "User-Agent": "Mozilla/5.0" }
    });
    const text = await res.text();
    const qualities = [];
    const regex = /RESOLUTION=(\d+)x(\d+)/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      qualities.push({ height: parseInt(match[2], 10) });
    }
    return qualities;
  } catch (err) {
    console.error("Errore parsing qualità:", err.message);
    return [];
  }
}

// ─── ENDPOINT HLS MOVIE ───────────────────────────────────────────────────────
app.get("/hls/movie/:id", async (req, res) => {
  const tmdbId = req.params.id;
  try {
    const [metaRes, playlistUrl] = await Promise.all([
      axios.get(`${TMDB_BASE}/movie/${tmdbId}`, {
        params: { api_key: TMDB_API_KEY, language: "it-IT" }
      }),
      vixsrcPlaylist(tmdbId)
    ]);
    const meta = metaRes.data;
    const pl = playlistUrl || await extractWithPuppeteer(`https://vixsrc.to/movie/${tmdbId}`);
    if (!pl) return res.status(404).json({ error: "Flusso non trovato" });
    const poster = meta.poster_path ? `${IMAGE_BASE}/w300${meta.poster_path}` : null;
    const qualities = await parseQualities(pl);
    res.json({
      title: meta.title,
      url: getProxyUrl(pl),
      canFHD: pl.includes("h=1"),
      poster,
      qualities,
      metadata: {
        overview: meta.overview,
        rating: meta.vote_average,
        year: meta.release_date?.split("-")[0]
      }
    });
  } catch (err) {
    console.error("Errore /hls/movie:", err.message);
    res.status(500).json({ error: "Errore nel recupero del film" });
  }
});

// ─── ENDPOINT HLS SHOW ────────────────────────────────────────────────────────
app.get("/hls/show/:id/:season/:episode", async (req, res) => {
  const { id, season, episode } = req.params;
  try {
    const [metaRes, playlistUrl] = await Promise.all([
      axios.get(`${TMDB_BASE}/tv/${id}/season/${season}/episode/${episode}`, {
        params: { api_key: TMDB_API_KEY, language: "it-IT" }
      }),
      vixsrcPlaylist(id, season, episode)
    ]);
    const meta = metaRes.data;
    const pl = playlistUrl || await extractWithPuppeteer(`https://vixsrc.to/tv/${id}/${season}/${episode}`);
    if (!pl) return res.status(404).json({ error: "Flusso non trovato" });
    const poster = meta.still_path ? `${IMAGE_BASE}/w300${meta.still_path}` : null;
    const qualities = await parseQualities(pl);
    res.json({
      title: meta.name,
      url: getProxyUrl(pl),
      canFHD: 
res.json({
      title: meta.name,
      url: getProxyUrl(pl),
      canFHD: pl.includes("h=1"),
      poster,
      qualities,
      metadata: {
        overview: meta.overview,
        rating: meta.vote_average,
        air_date: meta.air_date
      }
    });
  } catch (err) {
    console.error("Errore /hls/show:", err.message);
    res.status(500).json({ error: "Errore nel recupero episodio" });
  }
});