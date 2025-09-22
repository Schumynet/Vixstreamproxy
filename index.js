const express = require("express");
const puppeteer = require("puppeteer");
const app = express();

app.get("/hls/movie/:id", async (req, res) => {
  const tmdbId = req.params.id;
  const url = `https://vixsrc.to/movie/${tmdbId}`;

  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer"
      ]
    });

    const page = await browser.newPage();
    let hlsUrl = null;

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const reqUrl = request.url();
      if (reqUrl.includes(".m3u8") && !hlsUrl) {
        hlsUrl = reqUrl;
      }
      request.continue();
    });

    await page.goto(url, { timeout: 60000 });
    await page.waitForTimeout(5000);
    await browser.close();

    if (!hlsUrl) {
      return res.status(404).json({ error: "Nessun flusso trovato" });
    }

    res.json({ video: [{ label: "Auto", url: hlsUrl }] });
  } catch (err) {
    console.error("Errore:", err);
    res.status(500).json({ error: "Errore interno" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`FabioStream proxy attivo su porta ${PORT}`);
});