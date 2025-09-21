from fastapi import FastAPI, Query, Path
from fastapi.responses import JSONResponse, HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
import requests
from bs4 import BeautifulSoup

app = FastAPI()

# ✅ Abilita CORS per frontend esterno
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # puoi restringere al tuo dominio
    allow_methods=["*"],
    allow_headers=["*"],
)

TMDB_API_KEY = "INSERISCI_LA_TUA_API_KEY"

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

@app.get("/stream/movie/{tmdb_id}")
def stream_movie(tmdb_id: int):
    embed_url = f"https://vixsrc.to/movie/{tmdb_id}"
    r = requests.get(embed_url)
    soup = BeautifulSoup(r.text, "html.parser")

    iframe = soup.find("iframe", src=True)
    if not iframe or "ad" in iframe["src"]:
        return {"error": "Nessun stream valido trovato"}

    clean_iframe = f'<iframe src="{iframe["src"]}" width="100%" height="600" allowfullscreen></iframe>'
    return HTMLResponse(content=clean_iframe)

@app.get("/stream/show/{tmdb_id}/{season}/{episode}")
def stream_show(tmdb_id: int, season: int, episode: int):
    embed_url = f"https://vixsrc.to/tv/{tmdb_id}/{season}/{episode}"
    r = requests.get(embed_url)
    soup = BeautifulSoup(r.text, "html.parser")

    iframe = soup.find("iframe", src=True)
    if not iframe or "ad" in iframe["src"]:
        return {"error": "Nessun stream valido trovato"}

    clean_iframe = f'<iframe src="{iframe["src"]}" width="100%" height="600" allowfullscreen></iframe>'
    return HTMLResponse(content=clean_iframe)
