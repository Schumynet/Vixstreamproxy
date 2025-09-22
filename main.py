from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from playwright.sync_api import sync_playwright
import requests

app = FastAPI()

# 🔓 Abilita CORS per il frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

TMDB_API_KEY = "be78689897669066bef6906e501b0e10"

# 🔍 Ricerca TMDB in italiano
@app.get("/search")
def search_tmdb(query: str):
    url = "https://api.themoviedb.org/3/search/multi"
    params = {
        "api_key": TMDB_API_KEY,
        "query": query,
        "language": "it-IT"
    }
    res = requests.get(url, params=params)
    data = res.json()

    results = []
    for item in data.get("results", []):
        if item["media_type"] not in ["movie", "tv"]:
            continue

        results.append({
            "tmdb_id": item["id"],
            "title": item.get("title") or item.get("name"),
            "poster": f"https://image.tmdb.org/t/p/w500{item['poster_path']}" if item.get("poster_path") else "",
            "overview": item.get("overview", ""),
            "type": item["media_type"]
        })

    return results

# 🎬 Estrazione flusso HLS per film
@app.get("/hls/movie/{tmdb_id}")
def get_movie_stream(tmdb_id: int):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        hls_urls = []

        def handle_request(route):
            url = route.request.url
            if ".m3u8" in url and url not in hls_urls:
                hls_urls.append(url)
            route.continue_()

        page.route("**/*", handle_request)
        page.goto(f"https://vixsrc.to/movie/{tmdb_id}", timeout=60000)
        page.wait_for_timeout(5000)

        browser.close()

        if not hls_urls:
            return JSONResponse(content={"error": "Nessun flusso trovato"}, status_code=404)

        return { "video": [{ "label": "Auto", "url": hls_urls[0] }] }

# 📺 Estrazione flusso HLS per serie TV
@app.get("/hls/show/{tmdb_id}/{season}/{episode}")
def get_show_stream(tmdb_id: int, season: int, episode: int):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        hls_urls = []

        def handle_request(route):
            url = route.request.url
            if ".m3u8" in url and url not in hls_urls:
                hls_urls.append(url)
            route.continue_()

        page.route("**/*", handle_request)
        page.goto(f"https://vixsrc.to/show/{tmdb_id}/{season}/{episode}", timeout=60000)
        page.wait_for_timeout(5000)

        browser.close()

        if not hls_urls:
            return JSONResponse(content={"error": "Nessun flusso trovato"}, status_code=404)

        return { "video": [{ "label": "Auto", "url": hls_urls[0] }] }
