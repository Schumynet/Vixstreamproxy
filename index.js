// index.js - VixStream proxy (complete, ready for Render)
// Includes updated /watch HTML with your provided video + controls and safe JSON-serialized injections
const express   = require("express");
const axios     = require("axios");
const fetch     = require("node-fetch");
const http      = require("http");
const https     = require("https");
const puppeteer = require("puppeteer");
const path      = require("path");
const app       = express();
const PORT      = process.env.PORT || 10000;

const TMDB_API_KEY = process.env.TMDB_API_KEY || "be78689897669066bef6906e501b0e10";
const TMDB_BASE    = "https://api.themoviedb.org/3";
const IMAGE_BASE   = "https://image.tmdb.org/t/p";

app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // serve client files

// Simple CORS for all routes
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Range");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Utilities
function forceHttps(url) {
  try {
    if (!url || typeof url !== "string") return url;
    if (url.startsWith("https://") || url.startsWith("blob:") || url.startsWith("data:")) return url;
    if (url.startsWith("http://")) return url.replace(/^http:\/\//, "https://");
    return url;
  } catch (e) {
    return url;
  }
}

function getProxyUrl(originalUrl) {
  const safe = forceHttps(originalUrl);
  return `${process.env.PROXY_BASE || `https://vixstreamproxy.onrender.com`}/stream?url=${encodeURIComponent(safe)}`;
}

// Try to extract playlist tokens from vixsrc page
async function vixsrcPlaylist(tmdbId, season, episode) {
  const url = episode != null
    ? `https://vixsrc.to/tv/${tmdbId}/${season}/${episode}/?lang=it`
    : `https://vixsrc.to/movie/${tmdbId}?lang=it`;
  const resp = await axios.get(url, {
    headers: { "User-Agent":"Mozilla/5.0", "Referer":"https://vixsrc.to" },
    timeout: 15000
  });
  const txt = resp.data;
  const m = /token': '(.+)',\s*'expires': '(.+)',[\s\S]+?url: '(.+?)',[\s\S]+?window.canPlayFHD = (false|true)/.exec(txt);
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

// Puppeteer extractor: intercept requests to find .m3u8
async function extractWithPuppeteer(url) {
  let pl = null;
  let browser = null;
  try {
    browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", req => {
      const u = req.url();
      if (!pl && (u.includes("playlist") || u.endsWith(".m3u8") || u.includes("/hls/") || u.includes("rendition="))) {
        pl = u;
      }
      req.continue().catch(()=>{});
    });
    await page.goto(url, { timeout: 60000, waitUntil: "networkidle2" });
    await page.waitForTimeout(4000);
  } catch (e) {
    // ignore
  } finally {
    try { if (browser) await browser.close(); } catch(e){}
  }
  return pl;
}

// Parse tracks from an m3u8 for qualities, audio and subtitles
async function parseTracks(m3u8Url) {
  try {
    const res = await fetch(forceHttps(m3u8Url), {
      headers: { "Referer":"https://vixsrc.to", "User-Agent":"Mozilla/5.0" },
      timeout: 10000
    });
    const text = await res.text();
    const qualities = [], audioTracks = [], subtitles = [];
    text.split("\n").forEach(l => {
      if (l.includes("RESOLUTION=")) {
        const m = /RESOLUTION=\d+x(\d+)/.exec(l);
        if (m) qualities.push({ height: parseInt(m[1], 10) });
      }
      if (l.includes("TYPE=AUDIO")) {
        const m = /NAME="([^"]+)"/.exec(l);
        if (m) audioTracks.push(m[1]);
      }
      if (l.includes("TYPE=SUBTITLES")) {
        const m = /NAME="([^"]+)"/.exec(l);
        if (m) subtitles.push(m[1]);
      }
    });
    return { qualities, audioTracks, subtitles };
  } catch (err) {
    console.error("Errore parsing tracce:", err && err.message);
    return { qualities: [], audioTracks: [], subtitles: [] };
  }
}

// ── HLS metadata endpoints ───────────────────────────────────────────────────
app.get("/hls/movie/:id", async (req, res) => {
  const tmdbId = req.params.id;
  try {
    const [metaRes, playlistUrl] = await Promise.all([
      axios.get(`${TMDB_BASE}/movie/${tmdbId}`, {
        params: { api_key: TMDB_API_KEY, language: "it-IT" }, timeout: 15000
      }),
      vixsrcPlaylist(tmdbId).catch(()=>null)
    ]);
    const meta = metaRes.data;
    const pl = playlistUrl || await extractWithPuppeteer(`https://vixsrc.to/movie/${tmdbId}`);
    if (!pl) return res.status(404).json({ error: "Flusso non trovato" });

    const poster = meta.poster_path ? `${IMAGE_BASE}/w300${meta.poster_path}` : null;
    const { qualities, audioTracks, subtitles } = await parseTracks(pl);

    res.json({
      title: meta.title,
      url: getProxyUrl(pl),
      canFHD: pl.includes("h=1"),
      poster,
      qualities,
      audioTracks,
      subtitles,
      skipIntroTime: 60,
      metadata: {
        overview: meta.overview,
        rating: meta.vote_average,
        year: meta.release_date ? meta.release_date.split("-")[0] : null
      }
    });
  } catch (err) {
    console.error("Errore /hls/movie:", err && err.message);
    res.status(500).json({ error: "Errore nel recupero del film" });
  }
});

app.get("/hls/show/:id/:season/:episode", async (req, res) => {
  const { id, season, episode } = req.params;
  try {
    const [metaRes, playlistUrl] = await Promise.all([
      axios.get(`${TMDB_BASE}/tv/${id}/season/${season}/episode/${episode}`, {
        params: { api_key: TMDB_API_KEY, language: "it-IT" }, timeout: 15000
      }),
      vixsrcPlaylist(id, season, episode).catch(()=>null)
    ]);
    const meta = metaRes.data;
    const pl = playlistUrl || await extractWithPuppeteer(`https://vixsrc.to/tv/${id}/${season}/${episode}`);
    if (!pl) return res.status(404).json({ error: "Flusso non trovato" });

    const poster = meta.still_path ? `${IMAGE_BASE}/w300${meta.still_path}` : null;
    const { qualities, audioTracks, subtitles } = await parseTracks(pl);

    const seasonNum  = parseInt(season, 10);
    const episodeNum = parseInt(episode, 10);
    const nextEpisode = `/watch/show/${id}/${seasonNum}/${episodeNum + 1}`;
    const prevEpisode = episodeNum > 1 ? `/watch/show/${id}/${seasonNum}/${episodeNum - 1}` : null;

    res.json({
      title: meta.name,
      url: getProxyUrl(pl),
      canFHD: pl.includes("h=1"),
      poster,
      qualities,
      audioTracks,
      subtitles,
      skipIntroTime: 60,
      nextEpisode,
      prevEpisode,
      metadata: {
        overview: meta.overview,
        rating: meta.vote_average,
        air_date: meta.air_date
      }
    });
  } catch (err) {
    console.error("Errore /hls/show:", err && err.message);
    res.status(500).json({ error: "Errore nel recupero episodio" });
  }
});

// ── Resolve potential wrapper to real stream URL ────────────────────────────
async function resolveStreamUrl(maybeUrl) {
  try {
    const u = String(maybeUrl);
    if (/\.(m3u8)$/i.test(u) || u.toLowerCase().includes("playlist") || u.toLowerCase().includes("/hls/")) {
      return u;
    }

    try {
      const r = await fetch(forceHttps(u), { headers: { "User-Agent":"Mozilla/5.0", "Referer":"https://vixsrc.to" }, timeout: 10000 });
      const ct = r.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        const j = await r.json().catch(()=>null);
        if (j && j.url) return j.url;
      }
      const txt = await r.text().catch(()=>null);
      if (typeof txt === "string" && txt.includes(".m3u8")) {
        const m = txt.match(/https?:\/\/[^\s'"]+\.m3u8[^\s'"]*/);
        if (m) return m[0];
      }
    } catch (e) {
      // fall through to puppeteer
    }

    const pl = await extractWithPuppeteer(u);
    if (pl) return pl;
  } catch (e) {
    // ignore
  }
  return null;
}

// ── Stream proxy endpoint ───────────────────────────────────────────────────
app.get("/stream", async (req, res) => {
  const targetRaw = req.query.url;
  if (!targetRaw) return res.status(400).send("Missing url");

  const decoded = decodeURIComponent(targetRaw);
  const resolved = await resolveStreamUrl(decoded) || decoded;
  const target = forceHttps(resolved);
  const lower = String(target).toLowerCase();
  const isM3U8 = /\.m3u8$/i.test(lower) || lower.includes("playlist") || lower.includes("/hls/");

  let done = false;
  const sendErr = (st, msg) => {
    if (!done) { done = true; res.status(st).send(msg); }
  };

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Range");

  if (isM3U8) {
    try {
      const pr = await fetch(target, {
        headers: { "Referer":"https://vixsrc.to", "User-Agent":"Mozilla/5.0" },
        timeout: 15000
      });
      if (!pr.ok) return sendErr(502, "Origin returned non-200 for playlist");

      let txt = await pr.text();
      const urlObj = new URL(target);
      const base = urlObj.origin + target.substring(0, target.lastIndexOf("/"));

      txt = txt
        .replace(/URI="([^"]+)"/g, (_, u) => {
          const abs = u.startsWith("http") ? u : u.startsWith("/") ? `https://vixsrc.to${u}` : `${base}/${u}`;
          return `URI="${getProxyUrl(abs)}"`;
        })
        .replace(/^([^#\r\n].+\.(ts|key|vtt))$/gim, m => {
          const trimmed = m.trim();
          const abs = trimmed.startsWith("http") ? trimmed : `${base}/${trimmed}`;
          return getProxyUrl(abs);
        })
        .replace(/^(https?:\/\/[^\r\n]+)$/gim, m => {
          const trimmed = m.trim();
          return getProxyUrl(trimmed);
        });

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.send(txt);
      done = true;
    } catch (err) {
      console.error("Errore proxy m3u8:", err && err.message);
      sendErr(500, "Errore proxy m3u8");
    }
  } else {
    try {
      const uObj = new URL(target);
      const client = uObj.protocol === "https:" ? https : http;
      const options = {
        headers: {
          "Referer":"https://vixsrc.to",
          "User-Agent":"Mozilla/5.0",
          "Accept":"*/*",
          "Connection":"keep-alive"
        },
        timeout: 15000
      };
      const proxyReq = client.get(target, options, proxyRes => {
        proxyRes.headers['access-control-allow-origin'] = '*';
        const headers = { ...proxyRes.headers };
        res.writeHead(proxyRes.statusCode || 200, headers);
        proxyRes.pipe(res);
        done = true;
      });
      proxyReq.on("timeout", () => {
        proxyReq.destroy();
        sendErr(504, "Timeout");
      });
      proxyReq.on("error", err => {
        console.error("Errore proxy media:", err && err.message);
        sendErr(500, "Errore proxy media");
      });
      req.on("close", () => {
        try { proxyReq.destroy(); } catch(e){}
        done = true;
      });
    } catch (err) {
      console.error("URL invalido:", err && err.message);
      sendErr(400, "URL invalido");
    }
  }
});

// ── Player page (debug /watch) with updated HTML that includes your video + controls ─────────────────────
app.get("/watch/:type/:id/:season?/:episode?", async (req, res) => {
  const { type, id, season, episode } = req.params;
  const apiPath = type === "movie"
    ? `/hls/movie/${id}`
    : `/hls/show/${id}/${season}/${episode}`;

  try {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const { data } = await axios.get(`${baseUrl}${apiPath}`, { timeout:15000 });

    // Safe replacements for injected values
    const title = (data.title || "").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const poster = data.poster || "";
    const proxyUrl = data.url || "";
    const overview = (data.metadata && data.metadata.overview) ? data.metadata.overview.replace(/</g,"&lt;").replace(/>/g,"&gt;") : "";
    const nextEpisode = data.nextEpisode || "";
    const prevEpisode = data.prevEpisode || "";
    const skipIntro = data.skipIntroTime || 60;

    return res.send(`<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <title>VixStream — Player compatto (finale) - ${title}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
  <style>
    :root{
      --bg:#000; --panel:#0f0f10; --muted:#1b1b1d; --accent:#e50914; --text:#fff;
      --pad:12px; --compact-h:340px; --compact-h-sm:220px;
      --gap:14px;
    }
    html,body{height:100%;margin:0;background:var(--bg);color:var(--text);font-family:Inter,system-ui,Arial,sans-serif;-webkit-font-smoothing:antialiased}
    header{padding:10px 12px;background:var(--panel);display:flex;align-items:center;gap:10px}
    .back-btn{background:transparent;border:0;color:var(--text);font-size:18px;cursor:pointer;padding:6px;border-radius:6px}
    h1{margin:0;font-size:15px;flex:1}
    .search-bar{display:inline-flex;align-items:center;background:var(--muted);border-radius:6px;overflow:hidden}
    .search-bar input{width:170px;padding:6px;border:0;background:transparent;color:var(--text);outline:0;font-size:14px}
    .search-bar button{padding:6px 8px;border:0;background:var(--accent);color:var(--text);cursor:pointer}
    main{padding:10px;max-width:1100px;margin:0 auto}
    #results{display:flex;flex-wrap:wrap;gap:10px;padding:10px}
    .item{width:98px;text-align:center;cursor:pointer}
    .item img{width:100%;border-radius:6px;display:block}
    .item small{display:block;margin-top:6px;color:#a8a8a8;font-size:12px}

    /* modal base */
    .modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:120;align-items:center;justify-content:center;padding:12px;overflow:auto}
    .card{background:var(--panel);width:100%;max-width:960px;border-radius:10px;padding:var(--pad);box-sizing:border-box;box-shadow:0 10px 30px rgba(0,0,0,0.7);display:flex;flex-direction:column;max-height:90vh;overflow:hidden}
    .header-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
    .close-btn{background:transparent;border:0;color:var(--text);font-size:16px;cursor:pointer;padding:6px;border-radius:6px}

    .detailInner{display:flex;gap:12px;align-items:flex-start}
    .detailInner img{width:120px;border-radius:6px}
    .detailInfo h2{margin:0;font-size:16px}
    .detailInfo p{color:#ddd;margin-top:6px;line-height:1.3;font-size:13px}

    /* player */
    .player-card{padding:0;display:flex;flex-direction:column;border-radius:8px;overflow:hidden}
    .playerHeader{display:flex;align-items:center;gap:8px;padding:10px;background:rgba(0,0,0,0.6);border-bottom:1px solid #111}
    .playerBack{background:transparent;border:0;color:var(--text);padding:6px;border-radius:6px;cursor:pointer}
    .playerTitle{font-size:14px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

    .video-wrapper{position:relative;width:100%;max-height:var(--compact-h);background:#000}
    @media (max-width:900px){ .video-wrapper{max-height:var(--compact-h-sm)} }
    video{width:100%;height:100%;object-fit:cover;display:block;background:#000}

    /* center controls flat, no background */
    .center-controls{
      position:absolute;
      top:50%;
      left:50%;
      transform:translate(-50%,-50%);
      display:flex;
      gap:var(--gap);
      align-items:center;
      justify-content:center;
      z-index:10;
      transition:opacity .16s ease,transform .16s ease;
      pointer-events:auto;
    }
    .center-controls.hidden{opacity:0;pointer-events:none;transform:translate(-50%,-45%);}
    .nf-btn{
      width:48px;height:48px;
      background:transparent;border:0;padding:0;margin:0;
      display:inline-flex;align-items:center;justify-content:center;
      cursor:pointer;transition:transform .12s ease,opacity .12s ease;
    }
    .nf-btn svg{width:60%;height:60%;fill:#fff;display:block}
    .nf-btn:hover{transform:scale(1.08)}
    .nf-btn:active{transform:scale(0.96)}
    .nf-play{width:64px;height:64px}
    .nf-play svg{width:100%;height:100%}

    .bottom-bar{display:flex;align-items:center;justify-content:space-between;padding:8px;background:rgba(0,0,0,0.76);gap:8px}
    .left{display:flex;align-items:center;gap:10px;flex:1;min-width:0}
    .right{display:flex;align-items:center;gap:8px}
    .progress-track{flex:1;height:6px;background:rgba(255,255,255,0.06);border-radius:6px;overflow:hidden}
    .progress-track input[type=range]{width:100%;appearance:none;height:6px;background:transparent;margin:0}
    .progress-track input[type=range]::-webkit-slider-thumb{appearance:none;width:10px;height:10px;border-radius:50%;background:var(--accent);margin-top:-2px}
    .icon-btn{width:36px;height:36px;border-radius:8px;border:0;background:transparent;color:var(--text);display:flex;align-items:center;justify-content:center;cursor:pointer}
    .mini-menu{position:absolute;bottom:calc(100% + 10px);left:50%;transform:translateX(-50%);min-width:160px;background:rgba(20,20,20,0.98);color:var(--text);border-radius:8px;padding:8px;box-shadow:0 8px 24px rgba(0,0,0,0.6);z-index:70;display:none}
    .mini-menu.visible{display:block}
    .mini-menu .opt{padding:8px 10px;border-radius:6px;cursor:pointer;font-size:14px;color:#fff}
    .mini-menu .opt:hover{background:rgba(255,255,255,0.03)}
    .mini-menu .header{font-size:12px;color:#bbb;padding:0 8px 6px;margin-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.03)}
    .menu-container{position:relative;display:flex;align-items:center;justify-content:center}

    /* carousel */
    .carousel-wrapper{position:relative;overflow:hidden;padding:6px 0}
    .carousel-scroll{display:flex;gap:10px;overflow-x:auto;scroll-behavior:smooth;padding:6px 12px}
    .carousel-scroll::-webkit-scrollbar{display:none}
    .carousel-arrow{position:absolute;top:50%;transform:translateY(-50%);background:rgba(0,0,0,0.6);color:#fff;border:none;font-size:18px;padding:8px;border-radius:50%;cursor:pointer;z-index:10}
    .carousel-arrow.left{left:6px}
    .carousel-arrow.right{right:6px}
    .cardSmall, .epSmall{min-width:120px;flex:0 0 auto;text-align:center;cursor:pointer}
    .cardSmall img, .epSmall img{width:100%;border-radius:6px}
    .cardSmall .label, .epSmall .epTitle{margin-top:6px;font-size:13px;color:#ccc}
    .epSmall .epInfo{font-size:12px;color:#aaa}

    @media (max-width:600px){ .nf-btn{width:44px;height:44px} .nf-play{width:56px;height:56px} .playerHeader{padding:8px} }

    .toast{position:fixed;left:50%;transform:translateX(-50%);bottom:14px;background:rgba(20,20,20,0.95);color:#fff;padding:8px 12px;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,0.6);z-index:200;display:none}
    .toast.show{display:block;animation:toastin .28s ease}
    @keyframes toastin{from{transform:translate(-50%,8px);opacity:0}to{transform:translate(-50%,0);opacity:1}}
    .sr-only{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
  </style>
</head>
<body>
  <header>
    <button class="back-btn" id="globalBack">←</button>
    <h1>VixStream</h1>
    <div class="search-bar" role="search">
      <input id="searchInput" placeholder="Cerca titolo…" />
      <button id="searchBtn">🔍</button>
    </div>
  </header>

  <main>
    <section id="results"></section>
  </main>

  <!-- DETAIL modal -->
  <div id="detailModal" class="modal" aria-hidden="true">
    <div class="card">
      <div class="header-row">
        <div style="font-size:16px">Dettaglio</div>
        <button id="detailClose" class="close-btn">✕</button>
      </div>
      <div style="overflow:auto">
        <div class="detailInner">
          <img id="detailPoster" src="" alt="poster" loading="lazy">
          <div class="detailInfo">
            <h2 id="detailTitle">Titolo</h2>
            <div id="detailYear" style="color:#bbb;margin-top:6px"></div>
            <p id="detailOverview">Descrizione</p>
            <div style="margin-top:10px;color:#ccc;font-size:13px">
              <strong>Informazioni:</strong>
              <p id="detailMore">Generi, cast e altro.</p>
            </div>
            <div style="margin-top:10px">
              <button id="detailPlay" class="icon-btn">▶️ Play</button>
              <button id="detailBack" class="icon-btn">↩️ Indietro</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- SEASONS modal -->
  <div id="seasonsModal" class="modal" aria-hidden="true">
    <div class="card">
      <div class="header-row">
        <div style="font-size:16px">Seleziona Stagione</div>
        <button id="seasonsClose" class="close-btn">✕</button>
      </div>
      <div class="carousel-wrapper">
        <button class="carousel-arrow left" id="seasonsLeft">←</button>
        <div class="carousel-scroll" id="seasonsCarousel" aria-label="Stagioni"></div>
        <button class="carousel-arrow right" id="seasonsRight">→</button>
      </div>
    </div>
  </div>

  <!-- EPISODES modal -->
  <div id="episodesModal" class="modal" aria-hidden="true">
    <div class="card">
      <div class="header-row">
        <div style="font-size:16px">Seleziona Episodio</div>
        <button id="episodesClose" class="close-btn">✕</button>
      </div>
      <div class="carousel-wrapper">
        <button class="carousel-arrow left" id="episodesLeft">←</button>
        <div class="carousel-scroll" id="episodesCarousel" aria-label="Episodi"></div>
        <button class="carousel-arrow right" id="episodesRight">→</button>
      </div>
    </div>
  </div>

  <!-- PLAYER compact (your provided video + controls integrated) -->
  <div id="playerModal" class="modal" aria-hidden="true">
    <div class="card player-card" style="max-width:980px;">
      <div class="playerHeader">
        <button id="playerBack" class="playerBack" aria-label="Esci">←</button>
        <div id="playerTitle" class="playerTitle">Riproduzione</div>
        <div style="width:8px"></div>
      </div>

      <div class="video-wrapper" id="videoWrapper">
        <video id="video" playsinline crossorigin="anonymous" preload="metadata" poster="${poster}"></video>

        <div id="centerControls" class="center-controls hidden" role="group" aria-label="Controlli centrali">
          <button id="skipPrevEp" class="nf-btn" aria-label="Skip precedente" title="Skip precedente">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 5.5v13l8-6.5-8-6.5zM2 5h2v14H2z"/></svg>
          </button>

          <button id="rewind" class="nf-btn" aria-label="Riavvolgi 10" title="Riavvolgi 10">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 18V6l-8 6 8 6zm9 0V6l-8 6 8 6z"/></svg>
          </button>

          <button id="playPause" class="nf-play" aria-label="Play/Pausa" title="Play/Pausa">
            <svg id="playIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
            <svg id="pauseIcon" viewBox="0 0 24 24" aria-hidden="true" style="display:none"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
          </button>

          <button id="forward" class="nf-btn" aria-label="Avanti 10" title="Avanti 10">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 6v12l8-6-8-6zM3 6v12h2V6H3z"/></svg>
          </button>

          <button id="skipNextEp" class="nf-btn" aria-label="Skip successivo" title="Skip successivo">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.5 18.5V5.5l-8 6.5 8 6.5zM22 5h-2v14h2z"/></svg>
          </button>
        </div>
      </div>

      <div class="bottom-bar" id="bottomBar">
        <div class="left">
          <div class="progress-track" aria-hidden="false">
            <input type="range" id="progress" min="0" max="0" value="0" aria-label="Barra avanzamento" />
          </div>
        </div>

        <div class="right">
          <div class="menu-container" id="menuQuality">
            <button class="icon-btn" id="btnQuality" aria-label="Qualità">🎞️</button>
            <div class="mini-menu" id="miniQuality" role="menu" aria-hidden="true">
              <div class="header">Qualità</div>
              <div class="opt" data-q="-1">Auto</div>
              <div class="opt" data-q="hd">1080p</div>
              <div class="opt" data-q="sd">720p</div>
              <div class="opt" data-q="low">480p</div>
            </div>
          </div>

          <div class="menu-container" id="menuAudio">
            <button class="icon-btn" id="btnAudio" aria-label="Audio">🔈</button>
            <div class="mini-menu" id="miniAudio" role="menu" aria-hidden="true">
              <div class="header">Audio</div>
              <div class="opt" data-a="0">Italiano</div>
              <div class="opt" data-a="1">Originale</div>
            </div>
          </div>

          <div class="menu-container" id="menuSub">
            <button class="icon-btn" id="btnSub" aria-label="Sottotitoli">💬</button>
            <div class="mini-menu" id="miniSub" role="menu" aria-hidden="true">
              <div class="header">Sottotitoli</div>
              <div class="opt" data-s="-1">Off</div>
              <div class="opt" data-s="it">Italiano</div>
              <div class="opt" data-s="en">English</div>
            </div>
          </div>

          <button class="icon-btn" id="fullscreen" aria-label="Schermo intero">⛶</button>
        </div>
      </div>
    </div>
  </div>

  <div id="toast" class="toast" role="status"></div>

  <script>
    // Config (safe JSON-serialized)
    const TMDB_API_KEY = ${JSON.stringify(TMDB_API_KEY)};
    const proxyBase = ${JSON.stringify(process.env.PROXY_BASE || "https://vixstreamproxy.onrender.com")};

    // Helpers
    const $ = id => document.getElementById(id);
    const showModal = m => { if(!m) return; m.style.display='flex'; m.setAttribute('aria-hidden','false'); document.body.style.overflow='hidden'; };
    const hideModal = m => { if(!m) return; m.style.display='none'; m.setAttribute('aria-hidden','true'); document.body.style.overflow='auto'; };
    const toastEl = $('toast');
    function showToast(msg, ms=1600){ if(!toastEl) return; toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toastEl._t); toastEl._t = setTimeout(()=>toastEl.classList.remove('show'), ms); }

    async function safeFetchJSON(url){
      const res = await fetch(url);
      if(!res.ok){ throw new Error(`HTTP ${res.status}`); }
      const ct = res.headers.get('content-type')||'';
      if(!ct.includes('application/json')){ throw new Error('Non-JSON'); }
      return res.json();
    }

    // Elements
    const searchInput = $('searchInput'), searchBtn = $('searchBtn'), results = $('results');
    const detailModal = $('detailModal'), detailPoster = $('detailPoster'), detailTitle = $('detailTitle'), detailOverview = $('detailOverview'), detailYear = $('detailYear'), detailMore = $('detailMore');
    const detailPlay = $('detailPlay'), detailBack = $('detailBack'), detailClose = $('detailClose');
    const seasonsModal = $('seasonsModal'), seasonsCarousel = $('seasonsCarousel'), seasonsClose = $('seasonsClose');
    const episodesModal = $('episodesModal'), episodesCarousel = $('episodesCarousel'), episodesClose = $('episodesClose');
    const seasonsLeft = $('seasonsLeft'), seasonsRight = $('seasonsRight'), episodesLeft = $('episodesLeft'), episodesRight = $('episodesRight');

    const playerModal = $('playerModal'), playerBack = $('playerBack'), playerTitle = $('playerTitle');
    const video = $('video'), centerControls = $('centerControls'), bottomBar = $('bottomBar');
    const playPause = $('playPause'), rewind = $('rewind'), forward = $('forward');
    const skipPrevEp = $('skipPrevEp'), skipNextEp = $('skipNextEp');
    const progress = $('progress'), btnQuality = $('btnQuality'), miniQuality = $('miniQuality');
    const btnAudio = $('btnAudio'), miniAudio = $('miniAudio');
    const btnSub = $('btnSub'), miniSub = $('miniSub');
    const fullscreenBtn = $('fullscreen');

    // Play/pause icon toggle helpers
    const playIcon = $('playIcon'), pauseIcon = $('pauseIcon');
    function setPlaying(isPlaying){
      if(isPlaying){ playIcon.style.display='none'; pauseIcon.style.display='block'; }
      else { playIcon.style.display='block'; pauseIcon.style.display='none'; }
    }

    // Search
    async function doSearch(){
      const q = searchInput.value.trim(); if(!q) return;
      results.innerHTML = '<div style="padding:12px;color:#aaa">Ricerca in corso…</div>';
      try{
        const [tvRes,movieRes] = await Promise.all([
          safeFetchJSON(`https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&language=it-IT&query=${encodeURIComponent(q)}`),
          safeFetchJSON(`https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&language=it-IT&query=${encodeURIComponent(q)}`)
        ]);
        const items = [
          ...(tvRes.results||[]).map(r=>({...r,__type:'tv'})),
          ...(movieRes.results||[]).map(r=>({...r,__type:'movie'}))
        ];
        if(!items.length){ results.innerHTML = '<div style="padding:12px;color:#aaa">Nessun risultato</div>'; return; }
        results.innerHTML = items.map(it=>`
          <div class="item" data-id="${it.id}" data-type="${it.__type}">
            <img src="${it.poster_path ? 'https://image.tmdb.org/t/p/w200'+it.poster_path : ''}" alt="" loading="lazy">
            <small>${(it.name||it.title)||'—'} ${(it.first_air_date||it.release_date)?'('+((it.first_air_date||it.release_date)||'').slice(0,4)+')':''}</small>
          </div>
        `).join('');
      }catch(err){ console.error(err); results.innerHTML = `<div style="padding:12px;color:#f66">Errore ricerca</div>`; showToast('Errore ricerca'); }
    }
    searchBtn.addEventListener('click', doSearch);
    searchInput.addEventListener('keydown', e=>{ if(e.key==='Enter') doSearch(); });

    // Click result -> detail
    results.addEventListener('click', async ev=>{
      const el = ev.target.closest('.item'); if(!el) return;
      window.selectedId = el.dataset.id; window.selectedType = el.dataset.type;
      try{
        window.selectedTMDB = window.selectedType === 'movie'
          ? await safeFetchJSON(`https://api.themoviedb.org/3/movie/${window.selectedId}?api_key=${TMDB_API_KEY}&language=it-IT`)
          : await safeFetchJSON(`https://api.themoviedb.org/3/tv/${window.selectedId}?api_key=${TMDB_API_KEY}&language=it-IT`);
        detailPoster.src = window.selectedTMDB.poster_path ? 'https://image.tmdb.org/t/p/w300'+window.selectedTMDB.poster_path : '';
        detailTitle.textContent = window.selectedTMDB.title || window.selectedTMDB.name || 'Titolo';
        detailYear.textContent = (window.selectedTMDB.release_date||window.selectedTMDB.first_air_date||'').slice(0,4) || '';
        detailOverview.textContent = window.selectedTMDB.overview || '';
        detailMore.textContent = (window.selectedTMDB.genres||[]).map(g=>g.name).join(', ') || '';
        showModal(detailModal);
      }catch(err){ console.error(err); showToast('Errore dettagli'); }
    });

    detailClose.addEventListener('click', ()=> hideModal(detailModal));
    detailBack.addEventListener('click', ()=> hideModal(detailModal));

    // Play from detail
    detailPlay.addEventListener('click', async ()=>{
      if(window.playLock) return; window.playLock = true; setTimeout(()=>window.playLock=false,800);
      if(!window.selectedTMDB) return;
      hideModal(detailModal);
      if(window.selectedType === 'movie'){ window.selectedEpisode = null; await startStreamWithChecks(`${proxyBase}/hls/movie/${window.selectedId}`); return; }
      window.seasons = (window.selectedTMDB.seasons||[]).filter(s=>s.season_number>0);
      if(!window.seasons.length){ showToast('Nessuna stagione'); return; }
      renderSeasons(); showModal(seasonsModal);
    });

    function renderSeasons(){
      seasonsCarousel.innerHTML = window.seasons.map((s,idx)=>`
        <div class="cardSmall" data-index="${idx}">
          <img src="${s.poster_path? 'https://image.tmdb.org/t/p/w200'+s.poster_path : ''}" loading="lazy">
          <div class="label">S${s.season_number}</div>
        </div>
      `).join('');
      seasonsCarousel.scrollLeft = 0;
    }

    seasonsCarousel.addEventListener('click', async ev=>{
      const c = ev.target.closest('.cardSmall'); if(!c) return;
      window.selectedSeasonIndex = parseInt(c.dataset.index||0,10);
      const sn = window.seasons[window.selectedSeasonIndex].season_number;
      try{
        const data = await safeFetchJSON(`https://api.themoviedb.org/3/tv/${window.selectedId}/season/${sn}?api_key=${TMDB_API_KEY}&language=it-IT`);
        window.episodes = data.episodes || [];
        renderEpisodes();
        hideModal(seasonsModal);
        showModal(episodesModal);
      }catch(e){ console.error(e); showToast('Errore episodi'); }
    });

    seasonsLeft && seasonsLeft.addEventListener('click', ()=> scrollCarousel('seasonsCarousel', -1));
    seasonsRight && seasonsRight.addEventListener('click', ()=> scrollCarousel('seasonsCarousel', 1));
    seasonsClose.addEventListener('click', ()=> hideModal(seasonsModal));

    function renderEpisodes(){
      episodesCarousel.innerHTML = window.episodes.map((ep,idx)=>`
        <div class="epSmall" data-index="${idx}" data-episode="${ep.episode_number}">
          <img src="${ep.still_path ? 'https://image.tmdb.org/t/p/w300'+ep.still_path : ''}" loading="lazy">
          <div class="epTitle">E${ep.episode_number} — ${ep.name || 'Titolo'}</div>
          <div class="epInfo">${ep.air_date || ''}</div>
        </div>
      `).join('');
      episodesCarousel.scrollLeft = 0;
    }

    episodesCarousel.addEventListener('click', async ev=>{
      if(window.playLock) return; window.playLock = true; setTimeout(()=>window.playLock=false,800);
      const card = ev.target.closest('.epSmall'); if(!card) return;
      const idx = parseInt(card.dataset.index,10); if(isNaN(idx)) return;
      window.selectedEpisode = window.episodes[idx];
      const epNum = window.selectedEpisode.episode_number; const sn = window.seasons[window.selectedSeasonIndex].season_number;
      hideModal(episodesModal); await startStreamWithChecks(`${proxyBase}/hls/show/${window.selectedId}/${sn}/${epNum}`);
    });

    episodesLeft && episodesLeft.addEventListener('click', ()=> scrollCarousel('episodesCarousel', -1));
    episodesRight && episodesRight.addEventListener('click', ()=> scrollCarousel('episodesCarousel', 1));
    episodesClose.addEventListener('click', ()=> hideModal(episodesModal));

    function scrollCarousel(id, dir){
      const el = document.getElementById(id); if(!el) return;
      const amount = el.offsetWidth * 0.8; el.scrollBy({ left: dir * amount, behavior: 'smooth' });
    }

    // Stream start & open player
    async function startStreamWithChecks(proxyUrl){
      try{
        const res = await fetch(proxyUrl); if(!res.ok) throw new Error('Proxy error');
        const ct = res.headers.get('content-type')||''; if(!ct.includes('application/json')) throw new Error('Proxy non JSON');
        const data = await res.json(); if(!data||!data.url) throw new Error('Stream URL mancante');
        await openPlayer(data);
      }catch(err){ console.error(err); showToast('Errore stream'); }
    }

    // openPlayer and controls wiring
    let hls = null;
    async function openPlayer(data){
      showModal(playerModal);
      if(window.selectedEpisode){
        const seriesName = window.selectedTMDB?.name || window.selectedTMDB?.title || data.title || 'Episodio';
        const sNum = window.seasons[window.selectedSeasonIndex]?.season_number ?? '';
        const eNum = window.selectedEpisode?.episode_number ?? '';
        const eTitle = window.selectedEpisode?.name || '';
        playerTitle.textContent = `${seriesName} • S${sNum}E${eNum}${eTitle ? ' • ' + eTitle : ''}`;
      } else {
        playerTitle.textContent = data.title || 'Riproduzione';
      }

      if(hls){ try{ hls.destroy(); }catch(e){} hls=null; }
      try{ video.poster = data.poster || ''; }catch(e){}
      if(window.Hls && Hls.isSupported()){
        hls = new Hls();
        hls.loadSource(data.url);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (evt,ev)=>{ console.warn('HLS',ev); showToast('Errore HLS'); if(ev.fatal){ if(ev.type===Hls.ErrorTypes.NETWORK_ERROR) try{ hls.startLoad(); }catch(e){} else if(ev.type===Hls.ErrorTypes.MEDIA_ERROR) try{ hls.recoverMediaError(); }catch(e){} }});
        hls.on(Hls.Events.MANIFEST_PARSED, ()=>{ video.play().catch(()=>{}); });
      } else {
        video.src = data.url; video.load(); video.play().catch(()=>{});
      }

      video.addEventListener('loadedmetadata', ()=>{ progress.max = Math.floor(video.duration)||0; }, { once:true });
      video.addEventListener('timeupdate', ()=>{ progress.value = Math.floor(video.currentTime||0); }, false);
      video.addEventListener('play', ()=>{ setPlaying(true); showControls(); }, false);
      video.addEventListener('pause', ()=>{ setPlaying(false); showControls(); }, false);
    }

    // Controls interactions
    const showControls = (() => {
      let hideTimeout = null;
      return function(){
        centerControls.classList.remove('hidden');
        bottomBar.style.opacity = '1';
        clearTimeout(hideTimeout);
        hideTimeout = setTimeout(()=>{ centerControls.classList.add('hidden'); if(!video.paused) bottomBar.style.opacity='0.02'; }, 2400);
      };
    })();

    document.addEventListener('mousemove', showControls);
    document.addEventListener('touchstart', showControls);

    playPause.addEventListener('click', ()=>{ if(video.paused) video.play(); else video.pause(); showControls(); });
    rewind.addEventListener('click', ()=>{ try{ video.currentTime = Math.max(0,(video.currentTime||0)-10); }catch(e){} showControls(); });
    forward.addEventListener('click', ()=>{ try{ video.currentTime = Math.min(video.duration||0,(video.currentTime||0)+10); }catch(e){} showControls(); });

    skipPrevEp.addEventListener('click', async ()=>{ if(!window.episodes||!window.episodes.length) return; const idx = window.episodes.findIndex(e=>String(e.episode_number)===String(window.selectedEpisode?.episode_number)); const newIdx = Math.max(0,(idx<0?0:idx)-1); window.selectedEpisode = window.episodes[newIdx]; if(window.selectedEpisode){ const sn = window.seasons[window.selectedSeasonIndex].season_number; await startStreamWithChecks(`${proxyBase}/hls/show/${window.selectedId}/${sn}/${window.selectedEpisode.episode_number}`); }});
    skipNextEp.addEventListener('click', async ()=>{ if(!window.episodes||!window.episodes.length) return; const idx = window.episodes.findIndex(e=>String(e.episode_number)===String(window.selectedEpisode?.episode_number)); const newIdx = Math.min((window.episodes.length-1),(idx<0?0:idx)+1); window.selectedEpisode = window.episodes[newIdx]; if(window.selectedEpisode){ const sn = window.seasons[window.selectedSeasonIndex].season_number; await startStreamWithChecks(`${proxyBase}/hls/show/${window.selectedId}/${sn}/${window.selectedEpisode.episode_number}`); }});

    progress.addEventListener('input', ()=>{ try{ video.currentTime = progress.value; }catch(e){} showControls(); });

    fullscreenBtn.addEventListener('click', ()=>{ if(document.fullscreenElement) document.exitFullscreen(); else playerModal.requestFullscreen(); });

    // Mini menus
    function setupMini(btn, menu, onSelect){
      if(!btn||!menu) return;
      btn.addEventListener('click', e=>{ e.stopPropagation(); const visible = menu.classList.contains('visible'); closeAllMenus(); if(!visible){ menu.classList.add('visible'); menu.setAttribute('aria-hidden','false'); }});
      menu.addEventListener('click', e=>{ const opt = e.target.closest('.opt'); if(!opt) return; onSelect(opt); closeAllMenus(); });
    }
    function closeAllMenus(){ [miniQuality,miniAudio,miniSub].forEach(m=>{ if(m) m.classList.remove('visible'); m && m.setAttribute('aria-hidden','true'); }); }
    document.addEventListener('click', ()=> closeAllMenus());
    setupMini(btnQuality, miniQuality, opt=>{ showToast('Qualità: '+opt.textContent); if(hls){ const q=opt.dataset.q; if(q==='-1') hls.currentLevel = -1; else hls.currentLevel = parseInt(opt.dataset.q==='hd'?0:opt.dataset.q==='sd'?1:2,10); }});
    setupMini(btnAudio, miniAudio, opt=>{ showToast('Audio: '+opt.textContent); if(hls) hls.audioTrack = parseInt(opt.dataset.a,10); });
    setupMini(btnSub, miniSub, opt=>{ showToast('Sottotitoli: '+opt.textContent); if(hls) hls.subtitleTrack = parseInt(opt.dataset.s,10); });

    // Back / close actions
    playerBack.addEventListener('click', ()=>{ if(hls){ try{ hls.destroy(); }catch(e){} hls=null; } try{ video.pause(); video.removeAttribute('src'); video.load(); }catch(e){} hideModal(playerModal); });

    // Close modals by clicking outside
    [detailModal,seasonsModal,episodesModal,playerModal].forEach(mod=>{ mod.addEventListener('click', e=>{ if(e.target===mod) hideModal(mod); }); });

    // ESC key
    document.addEventListener('keydown', e=>{ if(e.key==='Escape'){ if(playerModal.style.display==='flex'){ playerBack.click(); } else if(episodesModal.style.display==='flex'){ hideModal(episodesModal); } else if(seasonsModal.style.display==='flex'){ hideModal(seasonsModal); } else if(detailModal.style.display==='flex'){ hideModal(detailModal); } }});

    // init
    results.innerHTML = '<div style="padding:12px;color:#aaa">Cerca un titolo sopra</div>';
    searchInput.focus();
  </script>
</body>
</html>`);
  } catch (err) {
    console.error("Errore /watch:", err && err.message);
    res.status(500).send("Errore nel caricamento del player");
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🎬 VixStream proxy in ascolto su http://0.0.0.0:${PORT}`);
});
