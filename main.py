from fastapi import FastAPI, Query
from fastapi.responses import Response
from utils import clean_manifest

app = FastAPI()

@app.get("/watch")
def watch(id: str = Query(...)):
    manifest_url = f"https://vixsrc.to/api/stream?id={id}"
    cleaned = clean_manifest(manifest_url)
    return Response(content=cleaned, media_type="application/vnd.apple.mpegurl")
