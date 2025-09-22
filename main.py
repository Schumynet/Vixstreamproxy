from fastapi import FastAPI, Query, Path
from fastapi.responses import JSONResponse, Response
from fastapi.middleware.cors import CORSMiddleware
import requests
from bs4 import BeautifulSoup

app = FastAPI()

# ✅ Abilita CORS per frontend esterno
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Puoi restringere al tuo dominio
    allow_methods=["*"],
    allow_headers=["*"],
)

# 🔑 Chiave TMDB personale
TMDB_API_KEY = "be78689897669066bef6906e501b0e10"

@app.get("/search")
def search(query: str):
    url = f"https://api.themoviedb.org/3/search/multi?api_key={TMDB_API_KEY}&query={query}"
    r = requests.get(url)
    results = r.json().get("results", [])

    simplified = []
    for item in results:
        if item.get("media_type") in ["movie", "tv"]:
            simplified.append({
                "tmdb_id": item["id"],
                "title": item.get("title") or item.get("name"),
                "overview": item.get("overview"),
                "poster": f"https://image.tmdb.org/t/p/w500{item.get('poster_path')}" if item.get("poster_path") else None,
                "type": item["media_type"]
            })

    return JSONResponse(content=simplified)

def extract_hls_from_embed(embed_url: str):
    r = requests.get(embed_url)
    soup = BeautifulSoup(r.text, "html.parser")
    iframe = soup.find("iframe", src=True)
    if not iframe:
        return None

    r2 = requests.get(iframe["src"])
    soup2 = BeautifulSoup(r2.text, "html.parser")

    for script in soup2.find_all("script"):
        if script.string and ".m3u8" in script.string:
            for part in script.string.split('"'):
                if ".m3u8" in part:
                    return part
    return None

@app.get("/hls/movie/{tmdb_id}")
def hls_movie(tmdb_id: int):
    embed_url = f"https://vixsrc.to/movie/{tmdb_id}"
    hls_link = extract_hls_from_embed(embed_url)
    if not hls_link:
        return {"error": "HLS non trovato"}

    manifest = requests.get(hls_link).text
    cleaned = "\n".join([
        line for line in manifest.splitlines()
        if "ad" not in line.lower() and "promo" not in line.lower()
    ])
    return Response(content=cleaned, media_type="application/vnd.apple.mpegurl")

@app.get("/hls/show/{tmdb_id}/{season}/{episode}")
def hls_show(tmdb_id: int, season: int, episode: int):
    embed_url = f"https://vixsrc.to/tv/{tmdb_id}/{season}/{episode}"
    hls_link = extract_hls_from_embed(embed_url)
    if not hls_link:
        return {"error": "HLS non trovato"}

    manifest = requests.get(hls_link).text
    cleaned = "\n".join([
        line for line in manifest.splitlines()
        if "ad" not in line.lower() and "promo" not in line.lower()
    ])
    return Response(content=cleaned, media_type="application/vnd.apple.mpegurl")
