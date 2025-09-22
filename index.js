const express = require("express");
const fetch = require("node-fetch");
const http = require("http");
const https = require("https");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 10000;

// 🔑 Chiave TMDB
const TMDB_API_KEY = "be78689897669066bef6906e501b0e10";

// 🔁 Funzione per costruire URL proxy
function getProxyUrl(originalUrl) {
  return `https://vixstreamproxy.onrender.com/stream?url=${encodeURIComponent(originalUrl)}`;
}

// 🔍 Estrazione playlist da VixSRC via regex
async function vixsrcPlaylist(tmdbId, seasonNumber, episodeNumber) {
  const targetUrl = seasonNumber !== undefined
    ? `https://vixsrc.to/tv/${tmdbId}/${seasonNumber}/${episodeNumber}/?lang=it`
    : `https://vixsrc.to/movie/${tmdbId}?lang=it`;

  const response = await axios.get(targetUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Referer": "https://vixsrc.to"
    }
  });

  const text = response.data;
  const playlistData = new RegExp(
    "token': '(.+)',\\n[ ]+'expires': '(.+)',\\n.+\\n.+\\n.+url: '(.+)',\\n[ ]+}\\n[ ]+window.canPlayFHD = (false|true)"
  ).exec(text);

  if (!playlistData) throw new Error("Regex match fallito");

  const token = playlistData[1];
  const expires = playlistData[2];
  const playlistUrl = new URL(playlistData[3]);
  const canPlayFHD = playlistData[4];
  const b = playlistUrl.searchParams.get("b");

  playlistUrl.searchParams.append("token", token);
  playlistUrl.searchParams.append("expires", expires);
  if (b !== null) playlistUrl.searchParams.append("b", b);
  if (canPlayFHD === "true") playlistUrl.searchParams.append("h", "1");

  return playlistUrl.toString();
}

// 🎬 Endpoint per film
app.get("/hls/movie/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const playlistUrl = await vixsrcPlaylist(id);
    res.json({ url: getProxyUrl(playlistUrl) });
  } catch (err) {
    console.error("❌ Errore proxy movie:", err.message);
    res.status(500).json({ error: "Errore estrazione film" });
  }
});

// 📺 Endpoint per serie TV
app.get("/hls/show/:id/:season/:episode", async (req, res) => {
  try {
    const { id, season, episode } = req.params;
    const playlistUrl = await vixsrcPlaylist(id, season, episode);
    res.json({ url: getProxyUrl(playlistUrl) });
  } catch (err) {
    console.error("❌ Errore proxy series:", err.message);
    res.status(500).json({ error: "Errore estrazione episodio" });
  }
});

// 🔁 Endpoint universale per servire flussi HLS
app.get("/stream", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("Missing url");

  const isM3U8 = targetUrl.includes(".m3u8") || targetUrl.includes("playlist") || targetUrl.includes("master");
  let responded = false;

  const sendResponse = (status, message) => {
    if (!responded) {
      responded = true;
      res.status(status).send(message);
    }
  };

  if (isM3U8) {
    try {
      const response = await fetch(targetUrl, {
        headers: {
          "Referer": "https://vixsrc.to",
          "User-Agent": "Mozilla/5.0"
        },
        timeout: 10000
      });

      let text = await response.text();
      const baseUrl = targetUrl.split("/").slice(0, -1).join("/");

      const rewritten = text
        .replace(/URI="([^"]+)"/g, (m, uri) => {
          const absoluteUrl = uri.startsWith("http") ? uri : uri.startsWith("/")
            ? `https://vixsrc.to${uri}` : `${baseUrl}/${uri}`;
          return `URI="${getProxyUrl(absoluteUrl)}"`;
        })
        .replace(/^([^\s#"][^\n\r"]+\.(ts|key|m3u8|vtt|webvtt))$/gm, (m, file) =>
          `${getProxyUrl(`${baseUrl}/${file}`)}`
        )
        .replace(/(https?:\/\/[^\s\n"]+)/g, m => getProxyUrl(m));

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.send(rewritten);
      responded = true;
    } catch (err) {
      console.error("Errore fetch m3u8:", err.message);
      sendResponse(500, "Errore proxy m3u8");
    }
  } else {
    try {
      const urlObj = new URL(targetUrl);
      const client = urlObj.protocol === "https:" ? https : http;

      const proxyReq = client.get(targetUrl, {
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
        responded = true;
      });

      proxyReq.on("timeout", () => {
        proxyReq.destroy();
        sendResponse(504, "Timeout");
      });

      proxyReq.on("error", err => {
        console.error("Errore segmento:", err.message);
        sendResponse(500, "Errore proxy media");
      });

      req.on("close", () => {
        proxyReq.destroy();
        responded = true;
      });
    } catch (err) {
      console.error("URL segmento invalido:", err.message);
      sendResponse(400, "URL invalido");
    }
  }
});

// 🚀 Avvio server
app.listen(PORT, () => {
  console.log(`🎬 VixStream HLS proxy attivo su http://0.0.0.0:${PORT}`);
});