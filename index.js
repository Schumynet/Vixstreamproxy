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

function getProxyUrl(originalUrl) {
  return `https://vixstreamproxy.onrender.com/stream?url=${encodeURIComponent(originalUrl)}`;
}

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

async function parseTracks(m3u8Url) {
  try {
    const res = await fetch(m3u8Url, {
      headers: { "Referer": "https://vixsrc.to", "User-Agent": "Mozilla/5.0" }
    });
    const text = await res.text();
    const qualities = [];
    const audioTracks = [];
    const subtitles = [];

    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.includes("RESOLUTION=")) {
        const match = /RESOLUTION=\d+x(\d+)/.exec(l);
        if (match) qualities.push({ height: parseInt(match[1], 10) });
      }
      if (l.includes("TYPE=AUDIO")) {
        const match = /NAME="([^"]+)"/.exec(l);
        if (match) audioTracks.push(match[1]);
      }
      if (l.includes("TYPE=SUBTITLES")) {
        const match = /NAME="([^"]+)"/.exec(l);
        if (match) subtitles.push(match[1]);
      }
    }

    return { qualities, audioTracks, subtitles };
  } catch (err) {
    console.error("Errore parsing tracce:", err.message);
    return { qualities: [], audioTracks: [], subtitles: [] };
  }
}

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
    console.error("Errore /hls/movie:", err.message);
    res.status(500).json({ error: "Errore nel recupero del film" });
  }
});

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
    const { qualities, audioTracks, subtitles } = await parseTracks(pl);

    const seasonNum = parseInt(season, 10);
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
    console.error("Errore /hls/show:", err.message);
    res.status(500).json({ error: "Errore nel recupero episodio" });
  }
});

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
      const base = new URL(target).origin + target.substring(0, target.lastIndexOf("/"));
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

app.listen(PORT, () => {
  console.log(`🎬 VixStream proxy in ascolto su http://0.0.0.0:${PORT}`);
});