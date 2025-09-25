// index.js - VixStream proxy adapted for Render
// - Serves static files from /public
// - /hls/movie/:id and /hls/show/:id/:season/:episode metadata endpoints
// - /stream?url=... proxy for m3u8 and media segments (rewrites playlist URIs)
// - /watch serves public/watch.html (avoid embedding HTML in template literals)
// - /config returns safe client-side config (tmdb key is optional)
//
// Notes for Render:
// - Add puppeteer to your dependencies if you rely on the extractor.
// - If Puppeteer causes deploy size issues, remove extractWithPuppeteer or use a lightweight approach.
// - Ensure the "public" folder exists with watch.html and assets.

const express = require("express");
const axios = require("axios");
const fetch = require("node-fetch");
const http = require("http");
const https = require("https");
const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 10000;

const TMDB_API_KEY = process.env.TMDB_API_KEY || ""; // set in Render env if needed
const PROXY_BASE = process.env.PROXY_BASE || `https://vixstreamproxy.onrender.com`;
const TMDB_BASE = "https://api.themoviedb.org/3";
const IMAGE_BASE = "https://image.tmdb.org/t/p";

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// CORS
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

// Try to extract playlist tokens from vixsrc page (best-effort)
async function vixsrcPlaylist(tmdbId, season, episode) {
  const url = episode != null
    ? `https://vixsrc.to/tv/${tmdbId}/${season}/${episode}/?lang=it`
    : `https://vixsrc.to/movie/${tmdbId}?lang=it`;
  try {
    const resp = await axios.get(url, {
      headers: { "User-Agent":"Mozilla/5.0", "Referer":"https://vixsrc.to" },
      timeout: 15000
    });
    const txt = resp.data || "";
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
  } catch (e) {
    return null;
  }
}

// Puppeteer extractor (intercepts requests looking for .m3u8)
async function extractWithPuppeteer(url) {
  let pl = null;
  let browser = null;
  try {
    browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", req => {
      const u = req.url();
      if (!pl && (u.includes(".m3u8") || u.includes("/hls/") || u.includes("playlist"))) {
        pl = u;
      }
      req.continue().catch(()=>{});
    });
    await page.goto(url, { timeout: 60000, waitUntil: "networkidle2" });
    await page.waitForTimeout(2500);
  } catch (e) {
    // ignore
  } finally {
    try { if (browser) await browser.close(); } catch(e){}
  }
  return pl;
}

// Parse an m3u8 to extract qualities, audio and subtitles (best-effort)
async function parseTracks(m3u8Url) {
  try {
    const r = await fetch(forceHttps(m3u8Url), { headers: { "User-Agent":"Mozilla/5.0", "Referer":"https://vixsrc.to" }, timeout: 10000 });
    if (!r.ok) return { qualities: [], audioTracks: [], subtitles: [] };
    const text = await r.text();
    const qualities = [], audioTracks = [], subtitles = [];
    text.split(/\r?\n/).forEach(line => {
      if (line.includes("RESOLUTION=")) {
        const m = /RESOLUTION=\d+x(\d+)/.exec(line);
        if (m) qualities.push({ height: parseInt(m[1], 10) });
      }
      if (line.includes("TYPE=AUDIO")) {
        const m = /NAME="([^"]+)"/.exec(line);
        if (m) audioTracks.push(m[1]);
      }
      if (line.includes("TYPE=SUBTITLES")) {
        const m = /NAME="([^"]+)"/.exec(line);
        if (m) subtitles.push(m[1]);
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

// Resolve wrapper to real stream URL (tries JSON, text and puppeteer)
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
      // fallback to puppeteer
    }

    const pl = await extractWithPuppeteer(u);
    if (pl) return pl;
  } catch (e) {
    // ignore
  }
  return null;
}

// Stream proxy endpoint
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

// /config endpoint for client-side use (non-sensitive)
app.get("/config", (req, res) => {
  res.json({
    proxyBase: PROXY_BASE,
    tmdbApiKey: TMDB_API_KEY ? "SET" : "" // avoid exposing full key; client can request server endpoints instead
  });
});

// Serve watch.html from public to avoid template literal issues
app.get("/watch/:type/:id/:season?/:episode?", (req, res) => {
  const watchPath = path.join(__dirname, "public", "watch.html");
  if (!fs.existsSync(watchPath)) {
    return res.status(500).send("Missing public/watch.html - place your client HTML there");
  }
  res.sendFile(watchPath);
});

// Start server
app.listen(PORT, () => {
  console.log(`🎬 VixStream proxy running on http://0.0.0.0:${PORT}`);
});
