from fastapi import FastAPI, Query
from fastapi.responses import Response, StreamingResponse
from utils import get_tmdb_data, get_vixsrc_manifest, clean_manifest
import requests

app = FastAPI()

@app.get("/metadata")
def metadata(query: str):
    return get_tmdb_data(query)

@app.get("/watch")
def watch(id: str):
    manifest = get_vixsrc_manifest(id)
    cleaned = clean_manifest(manifest)
    return Response(content=cleaned, media_type="application/vnd.apple.mpegurl")

@app.get("/segment")
def segment(url: str):
    r = requests.get(url, stream=True)
    return StreamingResponse(r.iter_content(1024), media_type="video/mp2t")
