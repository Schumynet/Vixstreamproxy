const express = require("express");
const axios = require("axios");
const fetch = require("node-fetch");
const http = require("http");
const https = require("https");
const puppeteer = require("puppeteer");

const app = express();
const PORT = process.env.PORT || 10000;

// 🔁 URL proxy
function getProxyUrl(originalUrl) {
  return `https://vixstreamproxy.onrender.com/stream?url=${encodeURIComponent(originalUrl)}`;
}

// 🔍 Regex primaria per estrazione playlist
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

  if (!playlistData) return null;

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

// 🧠 Fallback Puppeteer per estrazione flusso
async function extractWithPuppeteer(url) {
  let playlistUrl = null;

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: puppeteer.executablePath(),
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();

  await page.setRequestInterception(true);
  page.on("request", request => {
    const reqUrl = request.url();
    if (reqUrl.includes("playlist") && reqUrl.includes("rendition=") && !playlistUrl) {
      playlistUrl = reqUrl;
    }
    request.continue();
  });

  await page.goto(url, { timeout: 60000 });

  try {
    await page.waitForSelector("iframe", { timeout: 10000 });
    const frameHandle = await page.$("iframe");
    const frame = await frameHandle.contentFrame();
    await frame.click("body");
  } catch (err) {
    console.warn("⚠️ Click Puppeteer fallito:", err.message);
  }

  await new Promise(resolve => setTimeout(resolve, 10000));
  await browser.close();

  return playlistUrl;
}

// 🎬 Endpoint film
app.get("/hls/movie/:id", async (req, res) => {
  const { id } = req.params;
  let playlistUrl = await vixsrcPlaylist(id);
  if (!playlistUrl) playlistUrl = await extractWithPuppeteer(`https://vixsrc.to/movie/${id}`);
  if (!playlistUrl) return res.status(404).json({ error: "Flusso non trovato" });
  res.json({ url: getProxyUrl(playlistUrl) });
});

// 📺 Endpoint serie TV
app.get("/hls/show/:id/:season/:episode", async (req, res) => {
  const { id, season, episode } = req.params;
  let playlistUrl = await vixsrcPlaylist(id, season, episode);
  if (!playlistUrl) playlistUrl = await extractWithPuppeteer(`https://vixsrc.to/tv/${id}/${season}/${episode}`);
  if (!playlistUrl) return res.status(404).json({ error: "Flusso non trovato" });
  res.json({ url: getProxyUrl(playlistUrl) });
});

// 🔁 Proxy universale
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