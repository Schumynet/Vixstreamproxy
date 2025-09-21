import requests

TMDB_API_KEY = "8265bd1679663a7ea12ac168da84d2e8"

def get_tmdb_data(query: str):
    url = f"https://api.themoviedb.org/3/search/multi?api_key={TMDB_API_KEY}&query={query}"
    r = requests.get(url)
    return r.json()

def get_vixsrc_manifest(id: str) -> str:
    url = f"https://vixsrc.to/api/stream?id={id}"
    r = requests.get(url)
    return r.text

def clean_manifest(manifest: str) -> str:
    lines = manifest.splitlines()
    return "\n".join([
        f"/segment?url={line}" if line.endswith(".ts") else line
        for line in lines if "ad" not in line.lower() and "promo" not in line.lower()
    ])
