async function watch(tmdbId, type) {
  const endpoint = type === "movie"
    ? `/hls/movie/${tmdbId}`
    : `/hls/show/${tmdbId}/1/1`;

  try {
    const res = await fetch(`https://vixstreamproxy.onrender.com${endpoint}`);
    const manifest = await res.text();

    if (!manifest.includes("#EXTM3U")) {
      showError(document.getElementById("player"), "Stream non disponibile.");
      return;
    }

    const blob = new Blob([manifest], { type: "application/vnd.apple.mpegurl" });
    const manifestUrl = URL.createObjectURL(blob);

    loadVideo(manifestUrl);
  } catch (err) {
    console.error(err);
    showError(document.getElementById("player"), "Errore di rete o backend.");
  }
}
