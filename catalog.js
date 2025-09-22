const BACKEND_URL = "https://vixstreamproxy.onrender.com";
const catalogContainer = document.getElementById("catalogo");

async function loadCatalog() {
  const disponibili = await fetch(`${BACKEND_URL}/home/available`).then(r => r.json());

  for (const item of disponibili) {
    try {
      let metadata;
      if (item.type === "movie") {
        metadata = await fetch(`${BACKEND_URL}/metadata/movie/${item.tmdb_id}`).then(r => r.json());
      } else if (item.type === "tv") {
        metadata = await fetch(`${BACKEND_URL}/metadata/tv/${item.tmdb_id}`).then(r => r.json());
      } else {
        continue; // ignora tipo "episode" diretto
      }

      const card = document.createElement("div");
      card.className = "card";

      const imgSrc = metadata.posterUrl || metadata.stillUrl || "fallback.jpg";
      const title = metadata.title || metadata.name || "Senza titolo";

      card.innerHTML = `
        <img src="${imgSrc}" alt="${title}" />
        <h3>${title}</h3>
        <button onclick="watchContent(${item.tmdb_id}, '${item.type}')">Guarda ora</button>
      `;

      catalogContainer.appendChild(card);
    } catch (err) {
      console.warn("Errore caricamento contenuto:", item.tmdb_id, err);
    }
  }
}

async function watchContent(tmdbId, type) {
  let endpoint;
  if (type === "movie") {
    endpoint = `/hls/movie/${tmdbId}`;
  } else if (type === "tv") {
    endpoint = `/hls/show/${tmdbId}/1/1`; // default primo episodio
  } else {
    return alert("Tipo non supportato");
  }

  try {
    const res = await fetch(`${BACKEND_URL}${endpoint}`);
    const data = await res.json();
    if (!data.url) return alert("Stream non disponibile");

    loadVideo(data.url); // usa il tuo player.js
  } catch (err) {
    console.error("Errore riproduzione:", err);
    alert("Errore nel caricamento del video");
  }
}

// Avvia il caricamento al boot
loadCatalog();