// index.js

const express   = require("express");
const axios     = require("axios");
const fetch     = require("node-fetch");
const http      = require("http");
const https     = require("https");
const puppeteer = require("puppeteer");

const app  = express();
const PORT = process.env.PORT || 10000;

// ─── CONFIGURAZIONE TMDB ─────────────────────────────────────────────────────
const TMDB_API_KEY = process.env.TMDB_API_KEY || "be78689897669066bef6906e501b0e10";
const TMDB_BASE    = "https://api.themoviedb.org/3";
const IMAGE_BASE   = "https://image.tmdb.org/t/p";

// ─── JSON BODY PARSING ────────────────────────────────────────────────────────
app.use(express.json());

// ─── LISTA GENERI STATICI ────────────────────────────────────────────────────
const genres = [
  { id: 28,    name: "Azione",               emoji: "🎬",   slug: "azione",             type: "movie" },
  { id: 12,    name: "Avventura",            emoji: "🗺️",  slug: "avventura",          type: "movie" },
  { id: 16,    name: "Animazione",           emoji: "🎨",   slug: "animazione",         type: "movie" },
  { id: 35,    name: "Commedia",             emoji: "😂",   slug: "commedia",           type: "movie" },
  { id: 80,    name: "Crime",                emoji: "🔍",   slug: "crime",              type: "movie" },
  { id: 99,    name: "Documentario",         emoji: "📚",   slug: "documentario",       type: "movie" },
  { id: 18,    name: "Drammatico",           emoji: "🎭",   slug: "drammatico",         type: "movie" },
  { id: 10751,name: "Famiglia",             emoji: "👨‍👩‍👧",slug: "famiglia",           type: "movie" },
  { id: 14,    name: "Fantasy",              emoji: "🧙‍♂️", slug: "fantasy",            type: "movie" },
  { id: 36,    name: "Storia",               emoji: "🏰",   slug: "storia",             type: "movie" },
  { id: 27,    name: "Horror",               emoji: "👻",   slug: "horror",             type: "movie" },
  { id: 10402, name: "Musica",               emoji: "🎵",   slug: "musica",             type: "movie" },
  { id: 9648,  name: "Mistero",              emoji: "🕵️‍♂️",slug: "mistero",            type: "movie" },
  { id: 10749, name: "Romantico",            emoji: "❤️",   slug: "romantico",          type: "movie" },
  { id: 878,   name: "Fantascienza",         emoji: "🚀",   slug: "fantascienza",       type: "movie" },
  { id: 53,    name: "Thriller",             emoji: "😱",   slug: "thriller",           type: "movie" },
  { id: 10752, name: "Guerra",               emoji: "⚔️",   slug: "guerra",             type: "movie" },
  { id: 37,    name: "Western",              emoji: "🤠",   slug: "western",            type: "movie" },
  { id: 10770, name: "TV Movie",             emoji: "📺",   slug: "tv-movie",           type: "movie" },
  { id: 10759, name: "Azione & Avventura",   emoji: "🧨",   slug: "azione-avventura",   type: "tv"    },
  { id: 10764, name: "Reality",              emoji: "🎤",   slug: "reality",            type: "tv"    }
];

// ─── ENDPOINT GENERI ─────────────────────────────────────────────────────────
app.get("/genres", (req, res) => {
  res.json(genres);
});

app.get("/genres/:id", (req, res) => {
  const genreId = parseInt(req.params.id, 10);
  const genre = genres.find(g => g.id === genreId);
  if (!genre) return res.status(404).json({ error: "Genere non trovato" });
  res.json(genre);
});

// ─── DISCOVER MOVIE PER GENERE ───────────────────────────────────────────────
app.get("/discover/movie", async (req, res) => {
  const { with_genres, primary_release_year } = req.query;
  try {
    const { data } = await axios.get(`${TMDB_BASE}/discover/movie`, {
      params: {
        api_key: TMDB_API_KEY,
        language: "it-IT",
        sort_by: "popularity.desc",
        with_genres,
        primary_release_year
      }
    });
    const results = data.results.map(item => ({
      id: item.id,
      title: item.title,
      poster: item.poster_path ? `${IMAGE_BASE}/w500${item.poster_path}` : null,
      vote: item.vote_average,
      year: item.release_date?.split("-")[0] || null,
      genre_ids: item.genre_ids
    }));
    res.json(results);
  } catch (err) {
    console.error("Errore discover movie:", err.message);
    res.status(500).json({ error: "Errore discover movie" });
  }
});

// ─── DISCOVER TV PER GENERE ──────────────────────────────────────────────────
app.get("/discover/tv", async (req, res) => {
  const { with_genres, first_air_date_year } = req.query;
  try {
    const { data } = await axios.get(`${TMDB_BASE}/discover/tv`, {
      params: {
        api_key: TMDB_API_KEY,
        language: "it-IT",
        sort_by: "popularity.desc",
        with_genres,
        first_air_date_year
      }
    });
    const results = data.results.map(item => ({
      id: item.id,
      title: item.name,
      poster: item.poster_path ? `${IMAGE_BASE}/w500${item.poster_path}` : null,
      vote: item.vote_average,
      year: item.first_air_date?.split("-")[0] || null,
      genre_ids: item.genre_ids
    }));
    res.json(results);
  } catch (err) {
    console.error("Errore discover tv:", err.message);
    res.status(500).json({ error: "Errore discover tv" });
  }
});

// ─── CARICAMENTO CATALOGHI VixSrc ─────────────────────────────────────────────
let availableMovies   = [];
let availableTV       = [];
let availableEpisodes = [];

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
    console.error("❌ Errore caricamento cataloghi VixSrc:", err.message);
  }
}
loadCatalogs();
setInterval(loadCatalogs, 30 * 60 * 1000);

// ─── ENDPOINT DISPONIBILITÀ HOME ──────────────────────────────────────────────
app.get("/home/available", (req, res) => {
  const combined = [
    ...availableMovies.map(id   => ({ tmdb_id: id, type: "movie"  })),
    ...availableTV.map(id       => ({ tmdb_id: id, type: "tv"     })),
    ...availableEpisodes.map(id => ({ tmdb_id: id, type: "episode" }))
  ];
  res.json(combined);
});

// ─── METADATA & POSTER ────────────────────────────────────────────────────────
app.get("/metadata/movie/:id", async (req, res) => {
  try {
    const { data } = await axios.get(`${TMDB_BASE}/movie/${req.params.id}`, {
      params: { api_key: TMDB_API_KEY, language: "it-IT" }
    });
    const posterUrl = data.poster_path
      ? `${IMAGE_BASE}/w300${data.poster_path}`
      : null;
    res.json({ ...data, posterUrl });
  } catch {
    res.status(500).json({ error: "Impossibile recuperare metadata film" });
  }
});

app.get("/metadata/tv/:id", async (req, res) => {
  try {
    const { data } = await axios.get(`${TMDB_BASE}/tv/${req.params.id}`, {
      params: { api_key: TMDB_API_KEY, language: "it-IT" }
    });
    const posterUrl = data.poster_path
      ? `${IMAGE_BASE}/w300${data.poster_path}`
      : null;
    res.json({ ...data, posterUrl });
  } catch {
    res.status(500).json({ error: "Impossibile recuperare metadata serie" });
  }
});

app.get("/metadata/tv/:tvId/season/:season/episode/:episode", async (req, res) => {
  try {
    const { data } = await axios.get(
      `${TMDB_BASE}/tv/${req.params.tvId}/season/${req.params.season}/episode/${req.params.episode}`,
      { params: { api_key: TMDB_API_KEY, language: "it-IT" } }
    );
    const stillUrl = data.still_path
      ? `${IMAGE_BASE}/w300${data.still_path}`
      : null;
    res.json({ ...data, stillUrl });
  } catch {
    res.status(500).json({ error: "Impossibile recuperare metadata episodio" });
  }
});

// ─── HELPER PROXY HLS ─────────────────────────────────────────────────────────
function getProxyUrl(originalUrl) {
  return `https://vixstreamproxy.onrender.com/stream?url=${encodeURIComponent(originalUrl)}`;
}

// ─── ESTRAZIONE PLAYLIST VixSrc ───────────────────────────────────────────────
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
  if (b != null)           playlist.searchParams.set("b", b);
  if (canFHD === "true")   playlist.searchParams.set("h", "1");
  return playlist.toString();
}

// ─── FALLBACK PUPPETEER ───────────────────────────────────────────────────────
async function extractWithPuppeteer(url) {
  let pl = null;
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", req => {
      const u = req.url();
      if (!pl && u.includes("playlist") && u.includes("rendition=")) {
        pl = u;
      }
      req.continue();
    });
    await page.goto(url, { timeout: 60000 });
    await page.waitForTimeout(10000);
  } catch {}
  await browser.close();
  return pl;
}

// ─── HLS PER FILM ────────────────────────────────────────────────────────────
app.get("/hls/movie/:id", async (req, res) => {
  let pl = await vixsrcPlaylist(req.params.id);
  if (!pl) pl = await extractWithPuppeteer(`https://vixsrc.to/movie/${req.params.id}`);
  if (!pl) return res.status(404).json({ error: "Flusso non trovato" });
  res.json({ url: getProxyUrl(pl) });
});

// ─── HLS PER SERIE TV ────────────────────────────────────────────────────────
app.get("/hls/show/:id/:season/:episode", async (req, res) => {
  const { id, season, episode } = req.params;
  let pl = await vixsrcPlaylist(id, season, episode);
  if (!pl) pl = await extractWithPuppeteer(`https://vixsrc.to/tv/${id}/${season}/${episode}`);
  if (!pl) return res.status(404).json({ error: "Flusso non trovato" });
  res.json({ url: getProxyUrl(pl) });
});

// ─── PROXY UNIVERSALE PLAYLIST/SEGMENTI ──────────────────────────────────────
app.get("/stream", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send("Missing url");
  const isM3U8 = target.includes(".m3u8") || target.includes("playlist");
  let done = false;

  const sendErr = (st, msg) => {
    if (!done) { done = true; res.status(st).send(msg); }
  };

  if (isM3U8) {
    try {
      const pr = await fetch(target, {
        headers: { "Referer": "https://vixsrc.to", "User-Agent": "Mozilla/5.0" },
        timeout: 10000
      });
      let txt = await pr.text();
      const base = target.split("/").slice(0, -1).join("/");
      txt = txt
        .replace(/URI="([^"]+)"/g, (_, u) => {
          const abs = u.startsWith("http")
            ? u
            : u.startsWith("/")
              ? `https://vixsrc.to${u}`
              : `${base}/${u}`;
          return `URI="${getProxyUrl(abs)}"`;
        })
        .replace(/^([^#\r\n].+\.(ts|key|vtt))$/gm, m => getProxyUrl(`${base}/${m}`));
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.send(txt);
      done = true;
    } catch (err) {
      console.error("Errore proxy m3u8:", err.message);
      sendErr(500, "Errore proxy m3u8");
    }
  } else {
    try {
      const uObj = new URL(target);
      const client = uObj.protocol === "https:" ? https : http;
      const proxyReq = client.get(target, {
        headers: {
          "Referer": "https://vixsrc.to",
          "User-Agent": "Mozilla/5.0",
          "Accept": "*/*",
          "Connection": "keep-alive"
        },
        timeout: 10000
      }, proxyRes => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
        done = true;
      });
      proxyReq.on("timeout", () => {
        proxyReq.destroy();
        sendErr(504, "Timeout");
      });
      proxyReq.on("error", err => {
        console.error("Errore proxy media:", err.message);
        sendErr(500, "Errore proxy media");
      });
      req.on("close", () => {
        proxyReq.destroy();
        done = true;
      });
    } catch (err) {
      console.error("URL invalido:", err.message);
      sendErr(400, "URL invalido");
    }
  }
});

// ─── HOME CARDS ───────────────────────────────────────────────────────────────
app.get("/home/cards", async (req, res) => {
  const items = [
    ...availableMovies.map(id => ({ id, type: "movie" })),
    ...availableTV.map(id => ({ id, type: "tv" })),
    ...availableEpisodes.map(id => ({ id, type: "episode" }))
  ];

  const enriched = await Promise.all(items.map(async ({ id, type }) => {
    try {
      let data;
      if (type === "movie") {
        const resp = await axios.get(`${TMDB_BASE}/movie/${id}`, {
          params: { api_key: TMDB_API_KEY, language: "it-IT" }
        });
        data = {
          title: resp.data.title,
          overview: resp.data.overview,
          poster: resp.data.poster_path
            ? `${IMAGE_BASE}/w300${resp.data.poster_path}`
            : null,
          rating: resp.data.vote_average,
          hls: `/hls/movie/${id}`,
          type
        };
      } else if (type === "tv") {
        const resp = await axios.get(`${TMDB_BASE}/tv/${id}`, {
          params: { api_key: TMDB_API_KEY, language: "it-IT" }
        });
        data = {
          title: resp.data.name,
          overview: resp.data.overview,
          poster: resp.data.poster_path
            ? `${IMAGE_BASE}/w300${resp.data.poster_path}`
            : null,
          rating: resp.data.vote_average,
          hls: `/hls/show/${id}/1/1`,
          type
        };
      } else {
        const resp = await axios.get(
          `${TMDB_BASE}/tv/${id.tvId}/season/${id.season}/episode/${id.episode}`, 
          { params: { api_key: TMDB_API_KEY, language: "it-IT" } }
        );
        data = {
          title: resp.data.name,
          overview: resp.data.overview,
          poster: resp.data.still_path
            ? `${IMAGE_BASE}/w300${resp.data.still_path}`
            : null,
          rating: resp.data.vote_average,
          hls: `/hls/show/${id.tvId}/${id.season}/${id.episode}`,
          type
        };
      }
      return data;
    } catch {
      return null;
    }
  }));

  res.json(enriched.filter(Boolean));
});

// ─── SERVER START ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🎬 VixStream proxy in ascolto su http://0.0.0.0:${PORT}`);
});
