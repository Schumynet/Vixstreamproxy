from fastapi import FastAPI, Path, Query
from fastapi.responses import HTMLResponse, Response
import requests
from bs4 import BeautifulSoup

app = FastAPI()

@app.get("/stream/movie/{tmdb_id}")
def stream_movie(tmdb_id: int):
    embed_url = f"https://vixsrc.to/movie/{tmdb_id}"
    r = requests.get(embed_url)
    soup = BeautifulSoup(r.text, "html.parser")

    # Trova l'iframe video (escludi pubblicità)
    iframe = soup.find("iframe", src=True)
    if not iframe or "ad" in iframe["src"]:
        return {"error": "Nessun stream valido trovato"}

    # Restituisci solo l'iframe pulito
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
