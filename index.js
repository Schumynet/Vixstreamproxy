// index.js - VixStream proxy (fixed for Render)
// - Serves static files from /public
// - /hls/movie/:id and /hls/show/:id/:season/:episode metadata endpoints
// - /stream?url=... proxy for m3u8 and media segments (rewrites playlist URIs)
// - /config returns safe client-side config (no raw TMDB key exposed)
// - /watch serves public/watch.html (static file, edit client there)
//
// Notes:
// - Put your client HTML in public/watch.html
// - Set TMDB_API_KEY and optionally PROXY_BASE in Render environment variables
// - Puppeteer is optional: if unavailable, extractWithPuppeteer will simply return null

const express = require("express");
const axios = require("axios");
const fetch = require("node-fetch");
const http = require("http");
const https = require("https");
const path = require("path");
const fs = require("fs");

let puppeteer = null;
try { puppeteer = require("puppeteer"); } catch (e) { /* optional */ }

const app = express();
const PORT = process.env.PORT || 10000;

const TMDB_API_KEY = process.env.TMDB_API_KEY || ""; // optional
const PROXY_BASE = process.env.PROXY_BASE || `https://vixstreamproxy.onrender.com`;
const TMDB_BASE = "https://api.themoviedb.org/3";
const IMAGE_BASE = "https://image.tmdb.org/t/p";

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Basic CORS for endpoints used by client
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
  return `${PROXY_BASE}/stream?url=${encodeURIComponent(safe)}`;
}

// Try to extract playlist from page HTML (simple regex)
async function vixsrcPlaylist(tmdbId, season, episode) {
  try {
    const url = episode != null
      ? `https://vixsrc.to/tv/${tmdbId}/${season}/${episode}/?lang=it`
      : `https://vixsrc.to/movie/${tmdbId}?lang=it`;
    const resp = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://vixsrc.to" },
      timeout: 15000
    });
    const txt = resp.data || "";
    // Look for token and base url (best-effort)
    const m = /token':\s*'([^']+)'[\s\S]*?expires':\s*'([^']+)'[\s\S]*?url:\s*'([^']+)'[\s\S]*?window.canPlayFHD\s*=\s*(false|true)/.exec(txt);
    if (!m) return null;
    const [, token, expires, raw, canFHD] = m;
    const playlist = new URL(raw);
    const b = playlist.searchParams.get("b");
    playlist.searchParams.set("token", token);
    playlist.searchParams.set("expires", expires);
    if (b != null) playlist.searchParams.set("b", b);
    if (canFHD === "true") playlist.searchParams.set("h", "1");
    return playlist.toString();
  } catch (e) {
    return null;
  }
}

// Puppeteer fallback: intercept requests to find m3u8 (optional)
async function extractWithPuppeteer(url) {
  if (!puppeteer) return null;
  let browser = null;
  let found = null;
  try {
    browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", req => {
      const u = req.url();
      if (!found && (u.includes(".m3u8") || u.includes("/hls/") || u.includes("playlist"))) {
        found = u;
      }
      req.continue().catch(()=>{});
    });
    await page.goto(url, { timeout: 60000, waitUntil: "networkidle2" }).catch(()=>{});
    await page.waitForTimeout(2000);
  } catch (e) {
    // ignore
  } finally {
    try { if (browser) await browser.close(); } catch(e){}
  }
  return found;
}

// Best-effort parse of a playlist to extract tracks info
async function parseTracks(m3u8Url) {
  try {
    const res = await fetch(forceHttps(m3u8Url), {
      headers: { "Referer": "https://vixsrc.to", "User-Agent": "Mozilla/5.0" },
      timeout: 10000
    });
    if (!res.ok) return { qualities: [], audioTracks: [], subtitles: [] };
    const text = await res.text();
    const qualities = [], audioTracks = [], subtitles = [];
    text.split(/\r?\n/).forEach(line => {
      if (line.includes("RESOLUTION=")) {
        const mm = /RESOLUTION=\d+x(\d+)/.exec(line);
        if (mm) qualities.push({ height: parseInt(mm[1], 10) });
      }
      if (line.includes("TYPE=AUDIO")) {
        const mm = /NAME="([^"]+)"/.exec(line);
        if (mm) audioTracks.push(mm[1]);
      }
      if (line.includes("TYPE=SUBTITLES")) {
        const mm = /NAME="([^"]+)"/.exec(line);
        if (mm) subtitles.push(mm[1]);
      }
    });
    return { qualities, audioTracks, subtitles };
  } catch (e) {
    return { qualities: [], audioTracks: [], subtitles: [] };
  }
}

// HLS metadata endpoints
app.get("/hls/movie/:id", async (req, res) => {
  const tmdbId = req.params.id;
  try {
    const [metaRes, playlistUrl] = await Promise.all([
      axios.get(`${TMDB_BASE}/movie/${tmdbId}`, { params: { api_key: TMDB_API_KEY, language: "it-IT" }, timeout: 15000 }).catch(()=>({ data: {} })),
      vixsrcPlaylist(tmdbId).catch(()=>null)
    ]);
    const meta = metaRes.data || {};
    const pl = playlistUrl || await extractWithPuppeteer(`https://vixsrc.to/movie/${tmdbId}`);
    if (!pl) return res.status(404).json({ error: "Flusso non trovato" });

    const poster = meta.poster_path ? `${IMAGE_BASE}/w300${meta.poster_path}` : null;
    const { qualities, audioTracks, subtitles } = await parseTracks(pl);

    res.json({
      title: meta.title || null,
      url: getProxyUrl(pl),
      canFHD: String(pl).includes("h=1"),
      poster,
      qualities,
      audioTracks,
      subtitles,
      skipIntroTime: 60,
      metadata: {
        overview: meta.overview || null,
        rating: meta.vote_average || null,
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
      axios.get(`${TMDB_BASE}/tv/${id}/season/${season}/episode/${episode}`, { params: { api_key: TMDB_API_KEY, language: "it-IT" }, timeout: 15000 }).catch(()=>({ data: {} })),
      vixsrcPlaylist(id, season, episode).catch(()=>null)
    ]);
    const meta = metaRes.data || {};
    const pl = playlistUrl || await extractWithPuppeteer(`https://vixsrc.to/tv/${id}/${season}/${episode}`);
    if (!pl) return res.status(404).json({ error: "Flusso non trovato" });

    const poster = meta.still_path ? `${IMAGE_BASE}/w300${meta.still_path}` : null;
    const { qualities, audioTracks, subtitles } = await parseTracks(pl);

    const seasonNum = parseInt(season, 10);
    const episodeNum = parseInt(episode, 10);
    const nextEpisode = `/watch/show/${id}/${seasonNum}/${episodeNum + 1}`;
    const prevEpisode = episodeNum > 1 ? `/watch/show/${id}/${seasonNum}/${episodeNum - 1}` : null;

    res.json({
      title: meta.name || null,
      url: getProxyUrl(pl),
      canFHD: String(pl).includes("h=1"),
      poster,
      qualities,
      audioTracks,
      subtitles,
      skipIntroTime: 60,
      nextEpisode,
      prevEpisode,
      metadata: {
        overview: meta.overview || null,
        rating: meta.vote_average || null,
        air_date: meta.air_date || null
      }
    });
  } catch (err) {
    console.error("Errore /hls/show:", err && err.message);
    res.status(500).json({ error: "Errore nel recupero episodio" });
  }
});

// Try to resolve URL to a playable stream (m3u8) using several heuristics
async function resolveStreamUrl(maybeUrl) {
  try {
    const u = String(maybeUrl);
    if (/\.(m3u8)$/i.test(u) || u.toLowerCase().includes("playlist") || u.toLowerCase().includes("/hls/")) {
      return u;
    }

    try {
      const r = await fetch(forceHttps(u), { headers: { "User-Agent": "Mozilla/5.0", "Referer":"https://vixsrc.to" }, timeout: 10000 });
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
      // fallback to puppeteer
    }

    const pl = await extractWithPuppeteer(u);
    if (pl) return pl;
  } catch (e) {
    // ignore
  }
  return null;
}

// Stream proxy endpoint - handles playlists and media requests
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
      const pr = await fetch(target, { headers: { "Referer":"https://vixsrc.to", "User-Agent":"Mozilla/5.0" }, timeout: 15000 });
      if (!pr.ok) return sendErr(502, "Origin returned non-200 for playlist");

      let txt = await pr.text();
      // base for relative resolution
      let base = target;
      try {
        const uobj = new URL(target);
        base = uobj.origin + target.substring(0, target.lastIndexOf("/"));
      } catch (e) { /* ignore */ }

      // rewrite URIs and absolute segment lines to proxy them through /stream
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
    // proxy media (ts, key, mp4, etc.) with streaming
    try {
      const uObj = new URL(target);
      const client = uObj.protocol === "https:" ? https : http;
      const options = {
        headers: {
          "Referer": "https://vixsrc.to",
          "User-Agent": "Mozilla/5.0",
          "Accept": "*/*",
          "Connection": "keep-alive"
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

// Lightweight /config endpoint (no sensitive data)
app.get("/config", (req, res) => {
  res.json({
    proxyBase: PROXY_BASE,
    tmdbAvailable: !!TMDB_API_KEY
  });
});

// Serve watch.html (client) as static file
app.get("/watch/:type/:id/:season?/:episode?", (req, res) => {
  const watchPath = path.join(__dirname, "public", "watch.html");
  if (!fs.existsSync(watchPath)) {
    return res.status(500).send("Missing public/watch.html. Put your client HTML in public/watch.html");
  }
  res.sendFile(watchPath);
});

// Start server
app.listen(PORT, () => {
  console.log(`🎬 VixStream proxy running on http://0.0.0.0:${PORT} (PROXY_BASE=${PROXY_BASE})`);
});
