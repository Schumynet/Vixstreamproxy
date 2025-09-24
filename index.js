/**
 * index.js - VixStream proxy consolidato
 * Base URL proxy: https://vixstreamproxy.onrender.com
 *
 * Note: ES module entry (use node >= 14 with "type": "module" in package.json)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import express from 'express';
import fetch from 'node-fetch';
import https from 'https';
import http from 'http';
import axios from 'axios';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

// TMDB key (override with env if needed)
const TMDB_API_KEY = process.env.TMDB_API_KEY || '1e8c9083f94c62dd66fb2105cd7b613b';

// Axios defaults
axios.defaults.timeout = 30000;

// -----------------------------
// Middleware / basic settings
// -----------------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static public (watch.html etc.)
app.use(express.static(path.join(__dirname, 'public')));

// Global CORS (open)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Range,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// -----------------------------
// Utilities
// -----------------------------
function forceHttps(url) {
  try {
    if (!url || typeof url !== 'string') return url;
    if (url.startsWith('https://') || url.startsWith('blob:') || url.startsWith('data:')) return url;
    if (url.startsWith('http://')) return url.replace(/^http:\/\//, 'https://');
    return url;
  } catch (e) {
    return url;
  }
}

function getProxyUrl(originalUrl, currentReq = null) {
  // Use vixstreamproxy base
  const base = process.env.PROXY_BASE || 'https://vixstreamproxy.onrender.com';
  // keep streamId if present in query already
  try {
    if (originalUrl && originalUrl.includes('streamId=')) {
      return `${base}/stream?url=${encodeURIComponent(originalUrl)}`;
    }
  } catch (e) {}

  let streamId = 'default';
  if (currentReq && currentReq.query && currentReq.query.streamId) {
    streamId = currentReq.query.streamId;
  }
  return `${base}/stream?url=${encodeURIComponent(originalUrl)}&streamId=${encodeURIComponent(streamId)}`;
}

// -----------------------------
// VixSRC playlist extraction
// -----------------------------
async function vixsrcPlaylist(tmdbId, season, episode) {
  const url = (episode != null)
    ? `https://vixsrc.to/tv/${tmdbId}/${season}/${episode}/?lang=it`
    : `https://vixsrc.to/movie/${tmdbId}?lang=it`;
  const resp = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://vixsrc.to' },
    timeout: 15000
  });
  const txt = resp.data;
  const m = /token': '(.+)',\s*'expires': '(.+)',[\s\S]+?url: '(.+?)',[\s\S]+?window.canPlayFHD = (false|true)/.exec(txt);
  if (!m) return null;
  const [, token, expires, raw, canFHD] = m;
  const playlist = new URL(raw);
  const b = playlist.searchParams.get('b');
  playlist.searchParams.set('token', token);
  playlist.searchParams.set('expires', expires);
  if (b != null) playlist.searchParams.set('b', b);
  if (canFHD === 'true') playlist.searchParams.set('h', '1');
  return playlist.toString();
}

// -----------------------------
// Puppeteer extraction fallback
// -----------------------------
async function extractWithPuppeteer(url) {
  let pl = null;
  let browser = null;
  try {
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', req => {
      const u = req.url();
      if (!pl && (u.includes('playlist') || u.endsWith('.m3u8') || u.includes('/hls/') || u.includes('rendition='))) {
        pl = u;
      }
      req.continue().catch(()=>{});
    });
    await page.goto(url, { timeout: 60000, waitUntil: 'networkidle2' });
    await page.waitForTimeout(4000);
  } catch (e) {
    // ignore
  } finally {
    try { if (browser) await browser.close(); } catch(e){}
  }
  return pl;
}

// -----------------------------
// Resolve stream URL (JSON, text, or puppeteer)
// -----------------------------
async function resolveStreamUrl(maybeUrl) {
  try {
    const u = String(maybeUrl);
    if (/\.(m3u8)$/i.test(u) || u.toLowerCase().includes('playlist') || u.toLowerCase().includes('/hls/')) {
      return u;
    }

    try {
      const r = await fetch(forceHttps(u), {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://vixsrc.to' },
        timeout: 10000
      });
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        const j = await r.json().catch(()=>null);
        if (j && j.url) return j.url;
      }
      const txt = await r.text().catch(()=>null);
      if (typeof txt === 'string' && txt.includes('.m3u8')) {
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

// -----------------------------
// Parse tracks (qualities, audio, subtitles)
// -----------------------------
async function parseTracks(m3u8Url) {
  try {
    const res = await fetch(forceHttps(m3u8Url), {
      headers: { 'Referer': 'https://vixsrc.to', 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000
    });
    const text = await res.text();
    const qualities = [], audioTracks = [], subtitles = [];
    text.split('\n').forEach(l => {
      if (l.includes('RESOLUTION=')) {
        const m = /RESOLUTION=\d+x(\d+)/.exec(l);
        if (m) qualities.push({ height: parseInt(m[1], 10) });
      }
      if (l.includes('TYPE=AUDIO')) {
        const m = /NAME="([^"]+)"/.exec(l);
        if (m) audioTracks.push(m[1]);
      }
      if (l.includes('TYPE=SUBTITLES')) {
        const m = /NAME="([^"]+)"/.exec(l);
        if (m) subtitles.push(m[1]);
      }
    });
    return { qualities, audioTracks, subtitles };
  } catch (err) {
    console.error('Errore parsing tracce:', err && err.message);
    return { qualities: [], audioTracks: [], subtitles: [] };
  }
}

// -----------------------------
// HLS metadata endpoints (movie, show)
// -----------------------------
app.get('/hls/movie/:id', async (req, res) => {
  const tmdbId = req.params.id;
  try {
    const [metaRes, playlistUrl] = await Promise.all([
      axios.get(`${process.env.TMDB_BASE || 'https://api.themoviedb.org/3'}/movie/${tmdbId}`, {
        params: { api_key: TMDB_API_KEY, language: 'it-IT' }, timeout: 15000
      }),
      vixsrcPlaylist(tmdbId).catch(()=>null)
    ]);
    const meta = metaRes.data;
    const pl = playlistUrl || await extractWithPuppeteer(`https://vixsrc.to/movie/${tmdbId}`);
    if (!pl) return res.status(404).json({ error: 'Flusso non trovato' });

    const poster = meta.poster_path ? `https://image.tmdb.org/t/p/w300${meta.poster_path}` : null;
    const { qualities, audioTracks, subtitles } = await parseTracks(pl);

    res.json({
      title: meta.title,
      url: getProxyUrl(pl, req),
      canFHD: pl.includes('h=1'),
      poster,
      qualities,
      audioTracks,
      subtitles,
      skipIntroTime: 60,
      metadata: {
        overview: meta.overview,
        rating: meta.vote_average,
        year: meta.release_date ? meta.release_date.split('-')[0] : null
      }
    });
  } catch (err) {
    console.error('Errore /hls/movie:', err && err.message);
    res.status(500).json({ error: 'Errore nel recupero del film' });
  }
});

app.get('/hls/show/:id/:season/:episode', async (req, res) => {
  const { id, season, episode } = req.params;
  try {
    const [metaRes, playlistUrl] = await Promise.all([
      axios.get(`${process.env.TMDB_BASE || 'https://api.themoviedb.org/3'}/tv/${id}/season/${season}/episode/${episode}`, {
        params: { api_key: TMDB_API_KEY, language: 'it-IT' }, timeout: 15000
      }),
      vixsrcPlaylist(id, season, episode).catch(()=>null)
    ]);
    const meta = metaRes.data;
    const pl = playlistUrl || await extractWithPuppeteer(`https://vixsrc.to/tv/${id}/${season}/${episode}`);
    if (!pl) return res.status(404).json({ error: 'Flusso non trovato' });

    const poster = meta.still_path ? `https://image.tmdb.org/t/p/w300${meta.still_path}` : null;
    const { qualities, audioTracks, subtitles } = await parseTracks(pl);

    const seasonNum  = parseInt(season, 10);
    const episodeNum = parseInt(episode, 10);
    const nextEpisode = `/watch/show/${id}/${seasonNum}/${episodeNum + 1}`;
    const prevEpisode = episodeNum > 1 ? `/watch/show/${id}/${seasonNum}/${episodeNum - 1}` : null;

    res.json({
      title: meta.name,
      url: getProxyUrl(pl, req),
      canFHD: pl.includes('h=1'),
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
    console.error('Errore /hls/show:', err && err.message);
    res.status(500).json({ error: 'Errore nel recupero episodio' });
  }
});

// -----------------------------
// Proxy endpoints (movie/series -> returns proxied playlist url)
// -----------------------------
app.get('/proxy/movie/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const playlistUrl = await vixsrcPlaylist(id);
    // Optionally log content view in background
    const ip = req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : null) || req.connection.remoteAddress;
    logContentView(ip, 'movie', id).catch(()=>{});
    res.json({ url: getProxyUrl(playlistUrl, req) });
  } catch (err) {
    console.error('Errore proxy movie:', err && err.message);
    res.status(500).json({ error: 'Errore estrazione film' });
  }
});

app.get('/proxy/series/:id/:season/:episode', async (req, res) => {
  try {
    const { id, season, episode } = req.params;
    const playlistUrl = await vixsrcPlaylist(id, season, episode);
    const ip = req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : null) || req.connection.remoteAddress;
    logContentView(ip, 'series', id, season, episode).catch(()=>{});
    res.json({ url: getProxyUrl(playlistUrl, req) });
  } catch (err) {
    console.error('Errore proxy series:', err && err.message);
    res.status(500).json({ error: 'Errore estrazione episodio' });
  }
});

// -----------------------------
// Stream handlers
// - /proxy/stream  (advanced with streamId & abort control)
// - /stream        (universal single endpoint)
// -----------------------------
const activeStreams = new Map();
const PENDING_REQUESTS = new Map();

// /proxy/stream - advanced
app.get('/proxy/stream', async (req, res) => {
  const targetUrl = req.query.url;
  const streamId = req.query.streamId;
  if (!targetUrl || !streamId) return res.status(400).send('Parametri mancanti');

  let responded = false;
  const abortController = new AbortController();
  PENDING_REQUESTS.set(streamId, abortController);

  const sendResponse = (status, message) => {
    if (!responded) {
      responded = true;
      res.status(status).send(message);
      PENDING_REQUESTS.delete(streamId);
    }
  };

  req.on('close', () => {
    if (!responded) {
      abortController.abort();
      PENDING_REQUESTS.delete(streamId);
      responded = true;
    }
  });

  try {
    const response = await fetch(targetUrl, {
      headers: { 'Referer': 'https://vixsrc.to', 'User-Agent': 'Mozilla/5.0' },
      signal: abortController.signal,
      timeout: 15000
    });

    if (targetUrl.includes('.m3u8')) {
      let text = await response.text();
      const baseUrl = targetUrl.split('/').slice(0, -1).join('/');

      const rewritten = text
        .replace(/URI="([^"]+)"/g, (m, uri) => {
          const absoluteUrl = uri.startsWith('http') ? uri : uri.startsWith('/') ? `https://vixsrc.to${uri}` : `${baseUrl}/${uri}`;
          return `URI="${getProxyUrl(absoluteUrl)}"`;
        })
        .replace(/^([^\s#"][^\n\r"]+\.(ts|key|m3u8))$/gm, (m, file) => `${getProxyUrl(`${baseUrl}/${file}`)}`)
        .replace(/(https?:\/\/[^\s\n"]+)/g, m => getProxyUrl(m));

      if (!responded) {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(rewritten);
        responded = true;
      }
    } else {
      try {
        const urlObj = new URL(targetUrl);
        const client = urlObj.protocol === 'https:' ? https : http;
        const options = {
          headers: {
            'Referer': 'https://vixsrc.to',
            'User-Agent': 'Mozilla/5.0',
            'Accept': '*/*',
            'Connection': 'keep-alive'
          },
          timeout: 15000
        };
        const proxyReq = client.get(targetUrl, options, proxyRes => {
          proxyRes.headers['access-control-allow-origin'] = '*';
          const headers = { ...proxyRes.headers };
          res.writeHead(proxyRes.statusCode || 200, headers);
          proxyRes.pipe(res);
          responded = true;
          activeStreams.set(streamId, proxyReq);
        });
        proxyReq.on('timeout', () => {
          proxyReq.destroy();
          sendResponse(504, 'Timeout');
        });
        proxyReq.on('error', err => {
          console.error('Errore proxy media:', err && err.message);
          sendResponse(500, 'Errore proxy media');
        });
        req.on('close', () => {
          try { proxyReq.destroy(); } catch(e){}
          responded = true;
          PENDING_REQUESTS.delete(streamId);
          activeStreams.delete(streamId);
        });
      } catch (err) {
        console.error('URL invalido:', err && err.message);
        sendResponse(400, 'URL invalido');
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      // aborted by client
      return;
    } else {
      console.error(`Errore proxy stream ${streamId}:`, err && err.message);
      if (!res.headersSent) res.status(500).send('Errore durante il proxy');
    }
  }
});

// /stream - universal
app.get('/stream', async (req, res) => {
  const targetRaw = req.query.url;
  if (!targetRaw) return res.status(400).send('Missing url');

  const decoded = decodeURIComponent(targetRaw);
  const resolved = await resolveStreamUrl(decoded) || decoded;
  const target = forceHttps(resolved);
  const lower = String(target).toLowerCase();
  const isM3U8 = /\.m3u8$/i.test(lower) || lower.includes('playlist') || lower.includes('/hls/');

  let done = false;
  const sendErr = (st, msg) => {
    if (!done) { done = true; res.status(st).send(msg); }
  };

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Range');

  if (isM3U8) {
    try {
      const pr = await fetch(target, {
        headers: { 'Referer': 'https://vixsrc.to', 'User-Agent': 'Mozilla/5.0' },
        timeout: 15000
      });
      if (!pr.ok) return sendErr(502, 'Origin returned non-200 for playlist');

      let txt = await pr.text();
      const urlObj = new URL(target);
      const base = urlObj.origin + target.substring(0, target.lastIndexOf('/'));

      txt = txt
        .replace(/URI="([^"]+)"/g, (_, u) => {
          const abs = u.startsWith('http') ? u : u.startsWith('/') ? `https://vixsrc.to${u}` : `${base}/${u}`;
          return `URI="${getProxyUrl(abs)}"`;
        })
        .replace(/^([^#\r\n].+\.(ts|key|vtt))$/gim, m => {
          const trimmed = m.trim();
          const abs = trimmed.startsWith('http') ? trimmed : `${base}/${trimmed}`;
          return getProxyUrl(abs);
        })
        .replace(/^(https?:\/\/[^\r\n]+)$/gim, m => {
          const trimmed = m.trim();
          return getProxyUrl(trimmed);
        });

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.send(txt);
      done = true;
    } catch (err) {
      console.error('Errore proxy m3u8:', err && err.message);
      sendErr(500, 'Errore proxy m3u8');
    }
  } else {
    try {
      const uObj = new URL(target);
      const client = uObj.protocol === 'https:' ? https : http;
      const options = {
        headers: {
          'Referer': 'https://vixsrc.to',
          'User-Agent': 'Mozilla/5.0',
          'Accept': '*/*',
          'Connection': 'keep-alive'
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
      proxyReq.on('timeout', () => {
        proxyReq.destroy();
        sendErr(504, 'Timeout');
      });
      proxyReq.on('error', err => {
        console.error('Errore proxy media:', err && err.message);
        sendErr(500, 'Errore proxy media');
      });
      req.on('close', () => {
        try { proxyReq.destroy(); } catch(e){}
        done = true;
      });
    } catch (err) {
      console.error('URL invalido:', err && err.message);
      sendErr(400, 'URL invalido');
    }
  }
});

// -----------------------------
// Visitor & Content Logging
// -----------------------------
const dailyVisitors = {
  date: new Date().toDateString(),
  visitors: new Map()
};
const dailyContentViews = {
  date: new Date().toDateString(),
  views: new Map()
};
const tmdbTitleCache = new Map();

async function getTMDBTitle(tmdbId, contentType, season = null, episode = null) {
  const cacheKey = contentType === 'movie' ? `movie-${tmdbId}` : `tv-${tmdbId}-${season}-${episode}`;
  if (tmdbTitleCache.has(cacheKey)) return tmdbTitleCache.get(cacheKey);

  try {
    if (contentType === 'movie') {
      const response = await axios.get(`https://api.themoviedb.org/3/movie/${tmdbId}`, {
        params: { api_key: TMDB_API_KEY, language: 'it-IT' }, timeout: 15000
      });
      const title = response.data.title || response.data.original_title || `Film ${tmdbId}`;
      tmdbTitleCache.set(cacheKey, title);
      return title;
    } else {
      const [seriesResponse, episodeResponse] = await Promise.all([
        axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}`, { params: { api_key: TMDB_API_KEY, language: 'it-IT' }, timeout: 15000 }),
        axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${season}/episode/${episode}`, { params: { api_key: TMDB_API_KEY, language: 'it-IT' }, timeout: 15000 })
      ]);
      const seriesTitle = seriesResponse.data.name || seriesResponse.data.original_name || `Serie ${tmdbId}`;
      const episodeTitle = episodeResponse.data.name || `Episodio ${episode}`;
      const fullTitle = `${seriesTitle} - S${season}E${episode}: ${episodeTitle}`;
      tmdbTitleCache.set(cacheKey, fullTitle);
      return fullTitle;
    }
  } catch (err) {
    console.error('Errore recupero titolo TMDB:', err && err.message);
    const fallbackTitle = contentType === 'movie' ? `Film ${tmdbId}` : `Serie ${tmdbId} S${season}E${episode}`;
    tmdbTitleCache.set(cacheKey, fallbackTitle);
    return fallbackTitle;
  }
}

async function logContentView(ip, contentType, tmdbId, season = null, episode = null) {
  try {
    const today = new Date().toDateString();
    if (dailyContentViews.date !== today) {
      saveContentViewsReport();
      dailyContentViews.date = today;
      dailyContentViews.views = new Map();
    }
    if (!dailyContentViews.views.has(ip)) dailyContentViews.views.set(ip, []);
    const title = await getTMDBTitle(tmdbId, contentType, season, episode);
    const viewData = {
      timestamp: new Date().toISOString(),
      type: contentType,
      tmdbId: parseInt(tmdbId),
      title,
      season: season ? parseInt(season) : null,
      episode: episode ? parseInt(episode) : null
    };
    dailyContentViews.views.get(ip).push(viewData);
    console.log(`[${ip}] Visualizza: ${title}`);
  } catch (err) {
    console.error('Errore logContentView:', err && err.message);
  }
}

function saveContentViewsReport() {
  if (dailyContentViews.views.size === 0) return;
  const report = {
    date: dailyContentViews.date,
    totalViews: Array.from(dailyContentViews.views.values()).reduce((acc, views) => acc + views.length, 0),
    uniqueViewers: dailyContentViews.views.size,
    viewsByIP: Array.from(dailyContentViews.views.entries()).map(([ip, views]) => ({ ip, totalViews: views.length, content: views }))
  };
  const reportsDir = path.join(__dirname, 'content-reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir);
  const filename = path.join(reportsDir, `content-${dailyContentViews.date.replace(/\s+/g, '-')}.json`);
  fs.writeFileSync(filename, JSON.stringify(report, null, 2));
  console.log(`Report contenuti salvato: ${filename}`);
}

function loadExistingContentData() {
  const reportsDir = path.join(__dirname, 'content-reports');
  if (!fs.existsSync(reportsDir)) return;
  const today = new Date().toDateString();
  const files = fs.readdirSync(reportsDir);
  files.forEach(file => {
    if (file.includes(today.replace(/\s+/g, '-'))) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(reportsDir, file)));
        data.viewsByIP.forEach(viewer => {
          dailyContentViews.views.set(viewer.ip, viewer.content);
        });
        console.log('Caricati dati contenuti esistenti per oggi');
      } catch (err) {
        console.error('Errore caricamento dati contenuti:', err);
      }
    }
  });
}
loadExistingContentData();

// Admin endpoints for content views / stats
app.get('/admin/content-views', (req, res) => {
  const today = new Date().toDateString();
  if (dailyContentViews.date !== today) {
    saveContentViewsReport();
    dailyContentViews.date = today;
    dailyContentViews.views = new Map();
  }
  const viewsArray = Array.from(dailyContentViews.views.entries()).map(([ip, views]) => ({ ip, totalViews: views.length, content: views }));
  res.json({
    date: dailyContentViews.date,
    totalViews: viewsArray.reduce((acc, viewer) => acc + viewer.totalViews, 0),
    uniqueViewers: dailyContentViews.views.size,
    viewsByIP: viewsArray
  });
});

app.get('/admin/content-stats', (req, res) => {
  const contentStats = new Map();
  dailyContentViews.views.forEach(views => {
    views.forEach(view => {
      const key = view.type === 'movie' ? `movie-${view.tmdbId}` : `series-${view.tmdbId}`;
      if (!contentStats.has(key)) {
        contentStats.set(key, {
          type: view.type,
          tmdbId: view.tmdbId,
          title: view.title,
          season: view.season,
          episode: view.episode,
          viewCount: 0,
          uniqueViewers: new Set(),
          episodes: view.type === 'series' ? new Set() : null
        });
      }
      const stat = contentStats.get(key);
      stat.viewCount++;
      if (view.type === 'series') {
        stat.episodes.add(`S${view.season}E${view.episode}`);
        if (view.title && view.title.includes(' - S')) {
          stat.title = view.title.split(' - S')[0];
        }
      }
    });
  });

  const statsArray = Array.from(contentStats.values()).map(stat => ({
    ...stat,
    episodes: stat.episodes ? Array.from(stat.episodes).sort() : null
  })).sort((a, b) => b.viewCount - a.viewCount);

  res.json({ date: dailyContentViews.date, mostWatched: statsArray });
});

// Visitor logging middleware
app.use((req, res, next) => {
  if (req.path.endsWith('.ts')) return next();
  const realIp = req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : null) || req.connection.remoteAddress;
  const country = req.headers['cf-ipcountry'] || 'XX';
  if (!dailyVisitors.visitors.has(realIp)) {
    dailyVisitors.visitors.set(realIp, {
      count: 1,
      firstSeen: new Date(),
      lastSeen: new Date(),
      country,
      userAgent: req.headers['user-agent']
    });
  } else {
    const visitor = dailyVisitors.visitors.get(realIp);
    visitor.count++;
    visitor.lastSeen = new Date();
  }
  next();
});

app.get('/admin/visitors', (req, res) => {
  const today = new Date().toDateString();
  if (dailyVisitors.date !== today) {
    saveDailyReport();
    dailyVisitors.date = today;
    dailyVisitors.visitors = new Map();
  }
  const visitorsArray = Array.from(dailyVisitors.visitors.entries()).map(([ip, data]) => ({
    ip,
    ...data,
    firstSeen: data.firstSeen.toISOString(),
    lastSeen: data.lastSeen.toISOString()
  }));
  res.json({ date: dailyVisitors.date, totalVisitors: dailyVisitors.visitors.size, visitors: visitorsArray });
});

function saveDailyReport() {
  const report = {
    date: dailyVisitors.date,
    totalVisitors: dailyVisitors.visitors.size,
    visitors: Array.from(dailyVisitors.visitors.entries()).map(([ip, data]) => ({
      ip,
      ...data,
      firstSeen: data.firstSeen.toISOString(),
      lastSeen: data.lastSeen.toISOString()
    }))
  };
  const reportsDir = path.join(__dirname, 'visitor-reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir);
  const filename = path.join(reportsDir, `${dailyVisitors.date.replace(/\s+/g, '-')}.json`);
  fs.writeFileSync(filename, JSON.stringify(report, null, 2));
}

function loadExistingData() {
  const reportsDir = path.join(__dirname, 'visitor-reports');
  if (!fs.existsSync(reportsDir)) return;
  const today = new Date().toDateString();
  const files = fs.readdirSync(reportsDir);
  files.forEach(file => {
    if (file.includes(today.replace(/\s+/g, '-'))) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(reportsDir, file)));
        data.visitors.forEach(visitor => {
          dailyVisitors.visitors.set(visitor.ip, {
            count: visitor.count,
            firstSeen: new Date(visitor.firstSeen),
            lastSeen: new Date(visitor.lastSeen),
            country: visitor.country,
            userAgent: visitor.userAgent
          });
        });
      } catch (err) {
        console.error('Errore caricamento dati visitatori:', err);
      }
    }
  });
}
loadExistingData();

app.get('/admin/visitors/by-country', (req, res) => {
  const byCountry = {};
  dailyVisitors.visitors.forEach(visitor => {
    byCountry[visitor.country] = (byCountry[visitor.country] || 0) + 1;
  });
  res.json(byCountry);
});

// Protect admin endpoints with simple header token (optional)
app.use('/admin', (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || auth !== process.env.ADMIN_TOKEN && auth !== 'mason00') {
    return res.status(401).send('Accesso non autorizzato');
  }
  next();
});

// -----------------------------
// Watch progress (save/load)
// -----------------------------
const watchProgress = { data: new Map(), lastSave: Date.now() };

function saveWatchProgress() {
  const progressData = { timestamp: new Date().toISOString(), progress: Array.from(watchProgress.data.entries()) };
  const progressDir = path.join(__dirname, 'progress-data');
  if (!fs.existsSync(progressDir)) fs.mkdirSync(progressDir);
  const filename = path.join(progressDir, `progress-${Date.now()}.json`);
  fs.writeFileSync(filename, JSON.stringify(progressData, null, 2));
  watchProgress.lastSave = Date.now();
}

function loadExistingProgress() {
  const progressDir = path.join(__dirname, 'progress-data');
  if (!fs.existsSync(progressDir)) return;
  const files = fs.readdirSync(progressDir).sort().reverse().slice(0, 5);
  files.forEach(file => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(progressDir, file)));
      data.progress.forEach(([key, progressData]) => {
        watchProgress.data.set(key, progressData);
      });
      console.log(`Caricati ${data.progress.length} progressi da ${file}`);
    } catch (err) {
      console.error('Errore caricamento progressi:', err);
    }
  });
}
loadExistingProgress();
setInterval(() => { if (watchProgress.data.size > 0) saveWatchProgress(); }, 5 * 60 * 1000);

// Endpoints for progress
app.post('/progress/save', express.json(), (req, res) => {
  try {
    const { ip, tmdbId, contentType, season, episode, currentTime, duration, title } = req.body;
    if (!ip || !tmdbId || !contentType || currentTime == null || duration == null) {
      return res.status(400).json({ error: 'Parametri mancanti' });
    }
    const progressKey = `${ip}-${tmdbId}-${contentType}-${season || 0}-${episode || 0}`;
    const progressPercentage = (parseFloat(currentTime) / parseFloat(duration)) * 100;
    if (progressPercentage >= 5 && progressPercentage <= 91) {
      watchProgress.data.set(progressKey, {
        ip,
        tmdbId: parseInt(tmdbId),
        contentType,
        season: season ? parseInt(season) : null,
        episode: episode ? parseInt(episode) : null,
        currentTime: parseFloat(currentTime),
        duration: parseFloat(duration),
        progressPercentage: Math.round(progressPercentage),
        title: title || 'Senza titolo',
        lastUpdated: new Date().toISOString()
      });
    } else if (progressPercentage > 91) {
      watchProgress.data.delete(progressKey);
      console.log(`Contenuto completato: ${progressKey}`);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Errore salvataggio progresso:', err && err.message);
    res.status(500).json({ error: 'Errore interno' });
  }
});

app.get('/progress/:ip', (req, res) => {
  try {
    const { ip } = req.params;
    const userProgress = [];
    watchProgress.data.forEach((value, key) => {
      if (key.startsWith(`${ip}-`)) userProgress.push({ ...value, id: key });
    });
    userProgress.sort((a, b) => new Date(b.lastUpdated) - new Date(a.lastUpdated));
    res.json({ progress: userProgress });
  } catch (err) {
    console.error('Errore recupero progressi:', err && err.message);
    res.status(500).json({ error: 'Errore interno' });
  }
});

app.delete('/progress/:key', (req, res) => {
  try {
    const { key } = req.params;
    const deleted = watchProgress.data.delete(key);
    res.json({ success: deleted });
  } catch (err) {
    console.error('Errore rimozione progresso:', err && err.message);
    res.status(500).json({ error: 'Errore interno' });
  }
});

// -----------------------------
// Home endpoints: available + trending
// -----------------------------
const vixCache = { movie: { data: null, lastFetch: 0 }, tv: { data: null, lastFetch: 0 } };

async function fetchVixDatabase(type) {
  if (vixCache[type].data && Date.now() - vixCache[type].lastFetch < 86400000) return vixCache[type].data;
  try {
    const response = await axios.get(`https://vixsrc.to/api/list/${type}?lang=it`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://vixsrc.to' }
    });
    vixCache[type] = { data: response.data || [], lastFetch: Date.now() };
    return vixCache[type].data;
  } catch (err) {
    console.error(`Errore caricamento database VixSRC (${type}):`, err && err.message);
    return vixCache[type].data || [];
  }
}

app.get('/home/available', async (req, res) => {
  try {
    const [moviesRes, tvRes] = await Promise.all([
      axios.get('https://vixsrc.to/api/list/movie?lang=it', { headers: { 'Referer': 'https://vixsrc.to', 'User-Agent': 'Mozilla/5.0' } }),
      axios.get('https://vixsrc.to/api/list/tv?lang=it', { headers: { 'Referer': 'https://vixsrc.to', 'User-Agent': 'Mozilla/5.0' } })
    ]);
    res.json({ movies: moviesRes.data || [], tv: tvRes.data || [], lastUpdated: new Date().toISOString() });
  } catch (err) {
    console.error('Errore /home/available:', err && err.message);
    res.status(500).json({ error: 'Errore contenuti disponibili' });
  }
});

app.get('/home/trending', async (req, res) => {
  try {
    const [rawMovies, rawTV] = await Promise.all([ fetchVixDatabase('movie'), fetchVixDatabase('tv') ]);
    const vixMovieIds = new Set(rawMovies.map(e => e.tmdb_id));
    const vixTVIds = new Set(rawTV.map(e => e.tmdb_id));
    const [moviesRes, tvRes] = await Promise.all([
      axios.get(`https://api.themoviedb.org/3/trending/movie/day?language=it-IT&api_key=${TMDB_API_KEY}`),
      axios.get(`https://api.themoviedb.org/3/trending/tv/day?language=it-IT&api_key=${TMDB_API_KEY}`)
    ]);
    const movies = (moviesRes.data.results || []).filter(m => vixMovieIds.has(m.id));
    const tv = (tvRes.data.results || []).filter(s => vixTVIds.has(s.id));
    res.json({ movies, tv });
  } catch (err) {
    console.error('Errore /home/trending:', err && err.message);
    res.status(500).json({ error: 'Errore trending' });
  }
});

// -----------------------------
// Misc endpoints: watch page and root
// -----------------------------
app.get('/watch/:type/:id/:season?/:episode?', (req, res) => {
  const watchPath = path.join(__dirname, 'public', 'watch.html');
  if (!fs.existsSync(watchPath)) return res.status(500).send('Missing public/watch.html. Place your client HTML into public/watch.html');
  res.sendFile(watchPath);
});

app.get('/', (req, res) => res.send('<h1>Proxy attivo</h1>'));

// -----------------------------
// Global error handling & process handlers
// -----------------------------
app.use((err, req, res, next) => {
  console.error('Errore globale:', err && err.message);
  if (!res.headersSent) res.status(500).json({ error: 'Errore interno del server' });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  if (err && err.code === 'ECONNRESET') {
    console.log('Connessione client interrotta (uncaught)');
  } else {
    console.error('Uncaught Exception:', err && err.message);
    // do not exit immediately; allow restart logic to handle if needed
  }
});
process.on('warning', (warning) => {
  console.warn('Node Warning:', warning.name, warning.message);
});

// -----------------------------
// Server start with restart attempts
// -----------------------------
const MAX_RESTARTS = 5;
let restarts = 0;

function startServer() {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🎬 VixStream proxy in ascolto su http://0.0.0.0:${PORT}`);
    restarts = 0;
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Porta ${PORT} già in uso`);
    } else if (err.code === 'ECONNRESET') {
      console.warn('Connessione resettata dal client');
    } else {
      console.error('Errore del server:', err && err.message);
    }
    if (restarts < MAX_RESTARTS) {
      restarts++;
      console.log(`Riavvio tentativo ${restarts}/${MAX_RESTARTS}...`);
      setTimeout(startServer, 3000);
    }
  });

  // graceful shutdown on SIGINT
  process.on('SIGINT', () => {
    console.log('\n🛑 Arresto del server...');
    try { saveDailyReport(); } catch(e){}
    try { saveContentViewsReport(); } catch(e){}
    try { saveWatchProgress(); } catch(e){}
    process.exit();
  });
}

startServer();
