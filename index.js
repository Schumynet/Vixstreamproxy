const express   = require("express");
const axios     = require("axios");
const fetch     = require("node-fetch");
const http      = require("http");
const https     = require("https");
const puppeteer = require("puppeteer");
const app       = express();
const PORT      = process.env.PORT || 10000;

const TMDB_API_KEY = process.env.TMDB_API_KEY || "be78689897669066bef6906e501b0e10";
const TMDB_BASE    = "https://api.themoviedb.org/3";
const IMAGE_BASE   = "https://image.tmdb.org/t/p";

app.use(express.json());

// CORS semplice per tutte le route
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Range");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Utility: forzare https dove sensato
function forceHttps(url) {
  try {
    if (!url) return url;
    if (typeof url !== "string") return url;
    if (url.startsWith("https://") || url.startsWith("blob:") || url.startsWith("data:")) return url;
    if (url.startsWith("http://")) return url.replace(/^http:\/\//, "https://");
    return url;
  } catch (e) {
    return url;
  }
}

// Restituisce l'URL pubblico del proxy per lo streaming, con target già normalizzato in HTTPS
function getProxyUrl(originalUrl) {
  const safe = forceHttps(originalUrl);
  return `https://vixstreamproxy.onrender.com/stream?url=${encodeURIComponent(safe)}`;
}

// Estrae playlist da vixsrc (movie o episode)
async function vixsrcPlaylist(tmdbId, season, episode) {
  const url = episode != null
    ? `https://vixsrc.to/tv/${tmdbId}/${season}/${episode}/?lang=it`
    : `https://vixsrc.to/movie/${tmdbId}?lang=it`;
  const resp = await axios.get(url, {
    headers: { "User-Agent":"Mozilla/5.0", "Referer":"https://vixsrc.to" },
    timeout: 15000
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

// Estrattore con puppeteer (cattura richieste che contengono playlist)
async function extractWithPuppeteer(url) {
  let pl = null;
  let browser = null;
  try {
    browser = await puppeteer.launch({ headless:true, args:["--no-sandbox","--disable-setuid-sandbox"] });
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", req => {
      const u = req.url();
      if (!pl && (u.includes("playlist") || u.endsWith(".m3u8") || u.includes("/hls/") || u.includes("rendition="))) {
        pl = u;
      }
      req.continue().catch(()=>{});
    });
    await page.goto(url, { timeout:60000, waitUntil: "networkidle2" });
    await page.waitForTimeout(7000);
  } catch (e) {
    // ignore
  } finally {
    try{ if (browser) await browser.close(); } catch(e){}
  }
  return pl;
}

// Parse m3u8 per qualità, audio e sottotitoli
async function parseTracks(m3u8Url) {
  try {
    const res = await fetch(forceHttps(m3u8Url), {
      headers:{ "Referer":"https://vixsrc.to", "User-Agent":"Mozilla/5.0" },
      timeout: 10000
    });
    const text = await res.text();
    const qualities = [], audioTracks = [], subtitles = [];
    text.split("\n").forEach(l => {
      if (l.includes("RESOLUTION=")) {
        const m = /RESOLUTION=\d+x(\d+)/.exec(l);
        if (m) qualities.push({ height: parseInt(m[1],10) });
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
    return { qualities:[], audioTracks:[], subtitles:[] };
  }
}

// ── Endpoint /hls/movie/:id ───────────────────────────────────────────────────
app.get("/hls/movie/:id", async (req, res) => {
  const tmdbId = req.params.id;
  try {
    const [metaRes, playlistUrl] = await Promise.all([
      axios.get(`${TMDB_BASE}/movie/${tmdbId}`, {
        params:{ api_key:TMDB_API_KEY, language:"it-IT" }, timeout:15000
      }),
      vixsrcPlaylist(tmdbId).catch(()=>null)
    ]);
    const meta = metaRes.data;
    const pl = playlistUrl || await extractWithPuppeteer(`https://vixsrc.to/movie/${tmdbId}`);
    if (!pl) return res.status(404).json({ error:"Flusso non trovato" });

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
        year: meta.release_date?.split("-")[0]
      }
    });
  } catch (err) {
    console.error("Errore /hls/movie:", err && err.message);
    res.status(500).json({ error:"Errore nel recupero del film" });
  }
});

// ── Endpoint /hls/show/:id/:season/:episode ──────────────────────────────────
app.get("/hls/show/:id/:season/:episode", async (req, res) => {
  const { id, season, episode } = req.params;
  try {
    const [metaRes, playlistUrl] = await Promise.all([
      axios.get(`${TMDB_BASE}/tv/${id}/season/${season}/episode/${episode}`, {
        params:{ api_key:TMDB_API_KEY, language:"it-IT" }, timeout:15000
      }),
      vixsrcPlaylist(id, season, episode).catch(()=>null)
    ]);
    const meta = metaRes.data;
    const pl = playlistUrl || await extractWithPuppeteer(`https://vixsrc.to/tv/${id}/${season}/${episode}`);
    if (!pl) return res.status(404).json({ error:"Flusso non trovato" });

    const poster = meta.still_path ? `${IMAGE_BASE}/w300${meta.still_path}` : null;
    const { qualities, audioTracks, subtitles } = await parseTracks(pl);

    const seasonNum  = parseInt(season,10);
    const episodeNum = parseInt(episode,10);
    const nextEpisode = `/watch/show/${id}/${seasonNum}/${episodeNum + 1}`;
    const prevEpisode = episodeNum > 1
      ? `/watch/show/${id}/${seasonNum}/${episodeNum - 1}`
      : null;

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
    res.status(500).json({ error:"Errore nel recupero episodio" });
  }
});

// Risolvitore generico: prova a ottenere la playlist finale se l'URL è una pagina o wrapper
async function resolveStreamUrl(maybeUrl) {
  try {
    const u = String(maybeUrl);
    if (/\.(m3u8)$/i.test(u) || u.toLowerCase().includes("playlist") || u.toLowerCase().includes("/hls/")) {
      return u;
    }
    try {
      const r = await fetch(forceHttps(u), { headers:{ "User-Agent":"Mozilla/5.0", "Referer":"https://vixsrc.to" }, timeout:10000 });
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
      // ignore e proviamo puppeteer sotto
    }
    const pl = await extractWithPuppeteer(u);
    if (pl) return pl;
  } catch (e) {
    // ignore
  }
  return null;
}

// ── Endpoint /stream ──────────────────────────────────────────────────────────
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

  // header di sicurezza/CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Range");

  if (isM3U8) {
    try {
      const pr = await fetch(target, {
        headers:{ "Referer":"https://vixsrc.to", "User-Agent":"Mozilla/5.0" },
        timeout: 10000
      });
      if (!pr.ok) return sendErr(502, "Origin returned non-200 for playlist");

      let txt = await pr.text();
      const urlObj = new URL(target);
      const base = urlObj.origin + target.substring(0, target.lastIndexOf("/"));

      txt = txt
        .replace(/URI="([^"]+)"/g, (_, u) => {
          const abs = u.startsWith("http")
            ? u
            : u.startsWith("/")
              ? `https://vixsrc.to${u}`
              : `${base}/${u}`;
          return `URI="${getProxyUrl(abs)}"`;
        })
        .replace(/^([^#\r\n].+\.(ts|key|vtt))$/gim, m => {
          const trimmed = m.trim();
          const abs = trimmed.startsWith("http") ? trimmed : `${base}/${trimmed}`;
          return getProxyUrl(abs);
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
        headers:{
          "Referer":"https://vixsrc.to",
          "User-Agent":"Mozilla/5.0",
          "Accept":"*/*",
          "Connection":"keep-alive"
        },
        timeout: 10000
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
        try{ proxyReq.destroy(); }catch(e){}
        done = true;
      });
    } catch (err) {
      console.error("URL invalido:", err && err.message);
      sendErr(400, "URL invalido");
    }
  }
});

// ── Player di debug /watch ───────────────────────────────────────────────────
app.get("/watch/:type/:id/:season?/:episode?", async (req, res) => {
  const { type, id, season, episode } = req.params;
  const apiPath = type === "movie"
    ? `/hls/movie/${id}`
    : `/hls/show/${id}/${season}/${episode}`;

  try {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const { data } = await axios.get(`${baseUrl}${apiPath}`, { timeout:15000 });

    return res.send(`
      <!DOCTYPE html>
      <html lang="it">
      <head>
        <meta charset="UTF-8">
        <title>${data.title}</title>
        <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
        <style>
          body { margin:0; background:#000; color:#fff; font-family:sans-serif; }
          #container { max-width:960px; margin:20px auto; padding:10px; }
          .header { display:flex; justify-content:space-between; align-items:center; }
          video { width:100%; background:#000; }
          #controls { display:flex; flex-wrap:wrap; gap:8px; margin:12px 0; }
          select, button { background:#222; color:#fff; border:none; padding:6px 10px; border-radius:4px; cursor:pointer; }
          select:hover, button:hover { background:#444; }
        </style>
      </head>
      <body>
        <div id="container">
          <div class="header">
            <h2>${data.title}</h2>
            ${data.prevEpisode ? `<button onclick="location.href='${data.prevEpisode}'">⬅ Precedente</button>` : ""}
            ${data.nextEpisode ? `<button onclick="location.href='${data.nextEpisode}'">➡ Successivo</button>` : ""}
          </div>

          <video id="video" controls poster="${data.poster}" crossorigin="anonymous" playsinline></video>

          <div id="controls">
            <select id="qualitySelect">
              <option value="-1">Auto</option>
              ${data.qualities.map(q => `<option value="${q.height}">${q.height}p</option>`).join("")}
            </select>

            <select id="audioSelect">
              ${data.audioTracks.map((a,i) => `<option value="${i}">${a}</option>`).join("")}
            </select>

            <select id="subtitleSelect">
              <option value="-1">Nessuno</option>
              ${data.subtitles.map((s,i) => `<option value="${i}">${s}</option>`).join("")}
            </select>

            <button onclick="skipIntro()">⏩ Salta Intro</button>
            <button onclick="fullscreen()">⛶ Fullscreen</button>
          </div>

          <p>${data.metadata.overview}</p>
        </div>

        <script>
          const video = document.getElementById("video");
          const proxyUrl = "${data.url}";

          if (Hls && Hls.isSupported()) {
            const hls = new Hls({ debug: true });
            hls.attachMedia(video);
            hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(proxyUrl));
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
              document.getElementById("qualitySelect").onchange();
            });
            hls.on(Hls.Events.ERROR, (event, data) => {
              console.error("HLS error", event, data);
              if (data && data.fatal) {
                // log fatale
                console.error("Hls.js fatal error:", data);
              }
            });
            hls.on(Hls.Events.LEVEL_LOADED, (_, d) => console.log("LEVEL_LOADED", d));
            hls.on(Hls.Events.FRAG_LOADED, (_, d) => console.log("FRAG_LOADED", d));
            window._hls = hls;
          } else {
            // fallback nativo (unlikely su Brave/Chrome)
            video.src = proxyUrl;
          }

          document.getElementById("qualitySelect").onchange = function(){
            const h = parseInt(this.value,10);
            if (!window._hls) return;
            if(h === -1) window._hls.currentLevel = -1;
            else {
              const idx = window._hls.levels.findIndex(l => l.height === h);
              window._hls.currentLevel = idx;
            }
          };

          document.getElementById("audioSelect").onchange = function(){
            if (!window._hls) return;
            window._hls.audioTrack = parseInt(this.value,10);
          };

          document.getElementById("subtitleSelect").onchange = function(){
            if (!window._hls) return;
            window._hls.subtitleTrack = parseInt(this.value,10);
          };

          function skipIntro(){
            video.currentTime = ${data.skipIntroTime};
          }

          function fullscreen(){
            if(video.requestFullscreen) video.requestFullscreen();
            else if(video.webkitRequestFullscreen) video.webkitRequestFullscreen();
            else if(video.msRequestFullscreen) video.msRequestFullscreen();
          }
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("Errore /watch:", err && err.message);
    res.status(500).send("Errore nel caricamento del player");
  }
});

app.listen(PORT, () => {
  console.log(`🎬 VixStream proxy in ascolto su http://0.0.0.0:${PORT}`);
});
