// player.js

function showLoader(container) {
  container.innerHTML = `
    <div class="flex items-center justify-center h-[600px] bg-black text-white text-xl animate-pulse">
      🔄 Caricamento video...
    </div>
  `;
}

function showError(container, message) {
  container.innerHTML = `
    <div class="flex items-center justify-center h-[600px] bg-black text-red-500 text-xl">
      ❌ ${message}
    </div>
  `;
}

function loadVideo(manifestUrl, containerId = "player") {
  const container = document.getElementById(containerId);
  showLoader(container);

  setTimeout(() => {
    container.innerHTML = `
      <video id="videoPlayer" controls autoplay width="100%" height="600" style="background:#000; border-radius:8px;"></video>
    `;

    const video = document.getElementById("videoPlayer");

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        debug: false,
      });

      hls.loadSource(manifestUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play();
      });

      hls.on(Hls.Events.ERROR, (event, data) => {
        console.error("HLS.js error:", data);
        showError(container, "Errore nel caricamento del video.");
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = manifestUrl;
      video.addEventListener("loadedmetadata", () => {
        video.play();
      });
    } else {
      showError(container, "Il tuo browser non supporta HLS.");
    }
  }, 500);
}
