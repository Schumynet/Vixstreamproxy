;(async function () {
  // Carica HLS.js se non presente
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  await loadScript("https://cdn.jsdelivr.net/npm/hls.js@latest");

  const script = document.currentScript;
  const url = script.dataset.url;
  const title = script.dataset.title || "VixStream";
  const poster = script.dataset.poster || "";
  const next = script.dataset.next;
  const prev = script.dataset.prev;

  const container = document.createElement("div");
  container.style.maxWidth = "960px";
  container.style.margin = "20px auto";
  container.style.color = "#fff";
  container.style.fontFamily = "sans-serif";

  const header = document.createElement("div");
  header.style.display = "flex";
  header.style.justifyContent = "space-between";
  header.style.alignItems = "center";
  header.innerHTML = `<h2>${title}</h2>`;
  if (prev) {
    const btnPrev = document.createElement("button");
    btnPrev.textContent = "⬅ Precedente";
    btnPrev.onclick = () => location.href = prev;
    header.appendChild(btnPrev);
  }
  if (next) {
    const btnNext = document.createElement("button");
    btnNext.textContent = "➡ Successivo";
    btnNext.onclick = () => location.href = next;
    header.appendChild(btnNext);
  }
  container.appendChild(header);

  const video = document.createElement("video");
  video.id = "vixplayer";
  video.controls = true;
  video.poster = poster;
  video.style.width = "100%";
  video.style.background = "#000";
  container.appendChild(video);

  const controls = document.createElement("div");
  controls.style.display = "flex";
  controls.style.flexWrap = "wrap";
  controls.style.gap = "10px";
  controls.style.marginTop = "10px";

  const qualitySelect = document.createElement("select");
  qualitySelect.innerHTML = `<option value="-1">Qualità: Auto</option>`;
  controls.appendChild(qualitySelect);

  const audioSelect = document.createElement("select");
  audioSelect.innerHTML = `<option value="0">Audio: Default</option>`;
  controls.appendChild(audioSelect);

  const volumeSlider = document.createElement("input");
  volumeSlider.type = "range";
  volumeSlider.min = "0";
  volumeSlider.max = "1";
  volumeSlider.step = "0.01";
  volumeSlider.value = "1";
  controls.appendChild(volumeSlider);

  const btnSkip = document.createElement("button");
  btnSkip.textContent = "⏩ Salta Intro";
  btnSkip.onclick = () => video.currentTime = 60;
  controls.appendChild(btnSkip);

  const btnFS = document.createElement("button");
  btnFS.textContent = "⛶ Fullscreen";
  btnFS.onclick = () => video.requestFullscreen?.();
  controls.appendChild(btnFS);

  const btnPiP = document.createElement("button");
  btnPiP.textContent = "🖼️ PiP";
  btnPiP.onclick = () => video.requestPictureInPicture?.();
  controls.appendChild(btnPiP);

  container.appendChild(controls);
  script.parentNode.insertBefore(container, script.nextSibling);

  // Inizializza HLS
  if (Hls.isSupported()) {
    const hls = new Hls();
    hls.loadSource(url);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      hls.levels.forEach((level, i) => {
        const opt = document.createElement("option");
        opt.value = i;
        opt.textContent = `${level.height}p`;
        qualitySelect.appendChild(opt);
      });
    });

    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
      hls.audioTracks.forEach((track, i) => {
        const opt = document.createElement("option");
        opt.value = i;
        opt.textContent = track.name || `Audio ${i}`;
        audioSelect.appendChild(opt);
      });
    });

    qualitySelect.onchange = () => {
      const val = parseInt(qualitySelect.value);
      hls.currentLevel = val;
    };

    audioSelect.onchange = () => {
      hls.audioTrack = parseInt(audioSelect.value);
    };
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = url;
  }

  volumeSlider.oninput = () => {
    video.volume = parseFloat(volumeSlider.value);
  };
})();

app.use(express.static("public"))