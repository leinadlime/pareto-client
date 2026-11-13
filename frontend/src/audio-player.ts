// Persistent audio player.
//
// One Audio object lives outside the page content, so playback survives navigation inside the
// single-page client. Two custom elements talk to it:
//   <pareto-audio-trigger src type>   inline in an article, starts or pauses that file
//   <pareto-audio-bar lang>           in the layout, visible only while a file is loaded
// Nothing is created or fetched before the first click on a trigger.
// The position of each file is kept in localStorage and never sent anywhere.

type Track = {
  src: string;
  mimeType: string;
  title: string;
  author: string;
  image: string;
  origin: string;
};

const POSITIONS_KEY = "pareto-audio-positions";
const MAX_POSITIONS = 200;
const SKIP_SECONDS = 15;
const RATES = [1, 1.25, 1.5, 2, 0.75];
const BAR_HEIGHT = "4.5rem";

const LABELS: Record<string, Record<string, string>> = {
  en: {
    player: "Audio player",
    play: "Play",
    pause: "Pause",
    back: "Back 15 seconds",
    forward: "Forward 15 seconds",
    speed: "Playback speed",
    volume: "Volume",
    position: "Position",
    close: "Close player",
    origin: "Go to the article",
    error: "This audio cannot be played.",
    untitled: "Audio",
  },
  de: {
    player: "Audio-Player",
    play: "Abspielen",
    pause: "Pause",
    back: "15 Sekunden zurück",
    forward: "15 Sekunden vor",
    speed: "Tempo",
    volume: "Lautstärke",
    position: "Stelle",
    close: "Player schließen",
    origin: "Zum Artikel",
    error: "Dieses Audio lässt sich nicht abspielen.",
    untitled: "Audio",
  },
};

function labelsFor(lang: string | null): Record<string, string> {
  const short = (lang || document.documentElement.lang || navigator.language || "en").slice(0, 2).toLowerCase();
  return LABELS[short] || LABELS.en;
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "–:––";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
}

function readPositions(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(POSITIONS_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function writePosition(src: string, seconds: number | null) {
  try {
    const positions = readPositions();
    delete positions[src];
    if (seconds !== null) positions[src] = Math.floor(seconds);
    const keys = Object.keys(positions);
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_POSITIONS))) delete positions[key];
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions));
  } catch {
    // storage unavailable: playback works, the position is not kept
  }
}

class AudioPlayer extends EventTarget {
  audio: HTMLAudioElement | null = null;
  track: Track | null = null;
  failed = false;
  private lastSaved = 0;

  private ensureAudio(): HTMLAudioElement {
    if (this.audio) return this.audio;
    const audio = new Audio();
    audio.preload = "metadata";
    for (const name of ["play", "pause", "loadedmetadata", "durationchange", "ratechange", "volumechange", "seeked"]) {
      audio.addEventListener(name, () => this.changed());
    }
    audio.addEventListener("timeupdate", () => {
      if (this.track && Math.abs(audio.currentTime - this.lastSaved) >= 5) this.savePosition();
      this.changed();
    });
    audio.addEventListener("ended", () => {
      if (this.track) writePosition(this.track.src, null);
      this.changed();
    });
    audio.addEventListener("error", () => {
      if (!this.track) return;
      this.failed = true;
      this.changed();
    });
    window.addEventListener("pagehide", () => this.savePosition());
    this.audio = audio;
    return audio;
  }

  private changed() {
    this.dispatchEvent(new Event("change"));
  }

  private savePosition() {
    if (!this.audio || !this.track || this.failed) return;
    this.lastSaved = this.audio.currentTime;
    if (this.audio.currentTime > 5) writePosition(this.track.src, this.audio.currentTime);
  }

  isCurrent(src: string): boolean {
    return this.track !== null && this.track.src === src;
  }

  get playing(): boolean {
    return this.audio !== null && this.track !== null && !this.audio.paused && !this.audio.ended;
  }

  // Called from a click, so the browser allows playback.
  start(track: Track) {
    const audio = this.ensureAudio();
    if (this.isCurrent(track.src) && !this.failed) {
      this.toggle();
      return;
    }
    this.savePosition();
    this.track = track;
    this.failed = false;
    this.lastSaved = 0;
    const remembered = readPositions()[track.src] || 0;
    audio.src = track.src;
    if (remembered > 5) {
      audio.addEventListener(
        "loadedmetadata",
        () => {
          if (this.isCurrent(track.src) && (!isFinite(audio.duration) || remembered < audio.duration - 5)) {
            audio.currentTime = remembered;
          }
        },
        { once: true },
      );
    }
    this.setMediaSession(track);
    this.changed();
    audio.play().catch(() => this.changed());
  }

  toggle() {
    if (!this.audio || !this.track) return;
    if (this.audio.paused) {
      this.audio.play().catch(() => this.changed());
    } else {
      this.audio.pause();
      this.savePosition();
    }
  }

  skip(seconds: number) {
    if (!this.audio || !this.track) return;
    const end = isFinite(this.audio.duration) ? this.audio.duration : Infinity;
    this.audio.currentTime = Math.min(end, Math.max(0, this.audio.currentTime + seconds));
  }

  seek(seconds: number) {
    if (this.audio && this.track) this.audio.currentTime = seconds;
  }

  nextRate() {
    if (!this.audio) return;
    const index = RATES.indexOf(this.audio.playbackRate);
    this.audio.playbackRate = RATES[(index + 1) % RATES.length];
  }

  close() {
    if (!this.audio) return;
    this.audio.pause();
    this.savePosition();
    this.track = null;
    this.failed = false;
    this.audio.removeAttribute("src");
    this.audio.load();
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = "none";
    }
    this.changed();
  }

  private setMediaSession(track: Track) {
    if (!("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    session.metadata = new MediaMetadata({
      title: track.title,
      artist: track.author,
      artwork: track.image ? [{ src: track.image }] : [],
    });
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => this.audio?.play()],
      ["pause", () => this.audio?.pause()],
      ["seekbackward", (details) => this.skip(-(details.seekOffset || SKIP_SECONDS))],
      ["seekforward", (details) => this.skip(details.seekOffset || SKIP_SECONDS)],
      ["seekto", (details) => details.seekTime !== undefined && this.seek(details.seekTime)],
    ];
    for (const [action, handler] of handlers) {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // action not supported by this browser
      }
    }
  }
}

const player = new AudioPlayer();

const ICONS: Record<string, string> = {
  play: '<path d="M8 5v14l11-7z"/>',
  pause: '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>',
  back: '<path d="M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/>',
  forward: '<path d="M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z"/>',
  close: '<path d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6z"/>',
};

function icon(name: string): string {
  return `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">${ICONS[name]}</svg>`;
}

// Elm only intercepts links it rendered itself. A plain link from here would reload the page
// and stop the audio, so navigate through the history API and tell the application.
function navigateInApp(url: string) {
  history.pushState({}, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

class AudioTrigger extends HTMLElement {
  private button: HTMLButtonElement | null = null;
  private update = () => this.render();

  connectedCallback() {
    if (!this.button) {
      this.button = document.createElement("button");
      this.button.type = "button";
      this.button.style.cssText =
        "display:inline-flex;align-items:center;gap:0.5rem;padding:0.5rem 1rem;border:1px solid currentColor;" +
        "border-radius:9999px;background:transparent;color:inherit;font:inherit;cursor:pointer;margin:0.5rem 0";
      this.button.addEventListener("click", () => this.start());
      this.appendChild(this.button);
    }
    player.addEventListener("change", this.update);
    this.render();
  }

  disconnectedCallback() {
    player.removeEventListener("change", this.update);
  }

  private get src(): string {
    return this.getAttribute("src") || "";
  }

  private start() {
    const context = this.closest("[data-audio-title]") as HTMLElement | null;
    const labels = labelsFor(this.closest("[lang]")?.getAttribute("lang") || null);
    player.start({
      src: this.src,
      mimeType: this.getAttribute("type") || "",
      title: context?.dataset.audioTitle || labels.untitled,
      author: context?.dataset.audioAuthor || "",
      image: context?.dataset.audioImage || "",
      origin: location.pathname + location.search,
    });
  }

  private render() {
    if (!this.button) return;
    const labels = labelsFor(null);
    const active = player.isCurrent(this.src) && player.playing;
    const state = active ? "pause" : "play";
    if (this.button.dataset.state === state) return;
    this.button.dataset.state = state;
    this.button.setAttribute("aria-pressed", String(active));
    this.button.innerHTML = `${icon(state)}<span>${labels[state]}</span>`;
  }
}

const BAR_STYLE = `
  :host { display: block; position: fixed; z-index: 10; left: 0; right: 0; bottom: 3.5rem; height: ${BAR_HEIGHT};
          box-sizing: border-box; border-top-width: 1px; border-top-style: solid; }
  :host(:not([data-active])) { display: none; }
  @media (min-width: 640px) { :host { left: 5rem; bottom: 0; } }
  @media (min-width: 1280px) { :host { left: 13rem; } }
  @media print { :host { display: none; } }
  .bar { display: flex; flex-direction: column; justify-content: center; gap: 0.125rem; height: 100%; padding: 0 0.75rem; }
  .row { display: flex; align-items: center; gap: 0.5rem; min-width: 0; }
  .meta { flex: 1 1 0; min-width: 0; text-align: left; background: none; border: 0; padding: 0; color: inherit;
          font: inherit; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .meta .author { opacity: 0.7; margin-left: 0.5rem; }
  .error { color: #b91c1c; font-size: 0.875rem; }
  button.control { display: inline-flex; align-items: center; justify-content: center; min-width: 2rem; height: 2rem;
          border: 0; border-radius: 9999px; background: transparent; color: inherit; font: inherit; cursor: pointer; padding: 0 0.25rem; }
  button.control:hover { background: color-mix(in srgb, currentColor 12%, transparent); }
  button:focus-visible, input:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
  .rate { font-size: 0.875rem; font-variant-numeric: tabular-nums; min-width: 3rem; }
  .time { font-size: 0.75rem; font-variant-numeric: tabular-nums; opacity: 0.8; }
  input[type=range] { accent-color: currentColor; margin: 0; }
  .position { flex: 1 1 0; min-width: 0; }
  .volume { width: 5rem; }
  @media (max-width: 639px) { .volume { display: none; } }
`;

class AudioBar extends HTMLElement {
  private built = false;
  private seeking = false;
  private parts: Record<string, HTMLElement> = {};
  private update = () => this.render();

  connectedCallback() {
    if (!this.built) this.build();
    player.addEventListener("change", this.update);
    this.render();
  }

  disconnectedCallback() {
    player.removeEventListener("change", this.update);
  }

  private build() {
    this.built = true;
    const labels = labelsFor(this.getAttribute("lang"));
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>${BAR_STYLE}</style>
      <div class="bar" role="region" aria-label="${labels.player}">
        <div class="row">
          <button class="meta" type="button" data-part="meta" title="${labels.origin}">
            <span data-part="title"></span><span class="author" data-part="author"></span>
          </button>
          <span class="error" role="alert" data-part="error" hidden>${labels.error}</span>
          <input class="volume" type="range" min="0" max="1" step="0.05" data-part="volume" aria-label="${labels.volume}">
          <button class="control" type="button" data-part="back" aria-label="${labels.back}" title="${labels.back}">${icon("back")}</button>
          <button class="control" type="button" data-part="toggle"></button>
          <button class="control" type="button" data-part="forward" aria-label="${labels.forward}" title="${labels.forward}">${icon("forward")}</button>
          <button class="control rate" type="button" data-part="rate" title="${labels.speed}"></button>
          <button class="control" type="button" data-part="close" aria-label="${labels.close}" title="${labels.close}">${icon("close")}</button>
        </div>
        <div class="row">
          <span class="time" data-part="current"></span>
          <input class="position" type="range" min="0" max="0" step="1" data-part="position" aria-label="${labels.position}">
          <span class="time" data-part="duration"></span>
        </div>
      </div>`;
    root.querySelectorAll<HTMLElement>("[data-part]").forEach((el) => (this.parts[el.dataset.part!] = el));

    this.parts.meta.addEventListener("click", () => {
      const origin = player.track?.origin;
      if (origin && origin !== location.pathname + location.search) navigateInApp(origin);
    });
    this.parts.back.addEventListener("click", () => player.skip(-SKIP_SECONDS));
    this.parts.forward.addEventListener("click", () => player.skip(SKIP_SECONDS));
    this.parts.toggle.addEventListener("click", () => player.toggle());
    this.parts.rate.addEventListener("click", () => player.nextRate());
    this.parts.close.addEventListener("click", () => player.close());
    const volume = this.parts.volume as HTMLInputElement;
    volume.addEventListener("input", () => {
      if (player.audio) player.audio.volume = Number(volume.value);
    });
    const position = this.parts.position as HTMLInputElement;
    position.addEventListener("input", () => {
      this.seeking = true;
      this.parts.current.textContent = formatTime(Number(position.value));
    });
    position.addEventListener("change", () => {
      this.seeking = false;
      player.seek(Number(position.value));
    });
  }

  private render() {
    const track = player.track;
    const audio = player.audio;
    const active = track !== null && audio !== null;
    this.toggleAttribute("data-active", active);
    // The layout shortens the scrolling area by this much, so the bar never covers content.
    document.documentElement.style.setProperty("--pareto-audio-bar-height", active ? BAR_HEIGHT : "0px");
    if (!active) return;

    const labels = labelsFor(this.getAttribute("lang"));
    this.parts.title.textContent = track.title;
    this.parts.author.textContent = track.author;
    this.parts.error.hidden = !player.failed;

    const state = player.playing ? "pause" : "play";
    if (this.parts.toggle.dataset.state !== state) {
      this.parts.toggle.dataset.state = state;
      this.parts.toggle.innerHTML = icon(state);
      this.parts.toggle.setAttribute("aria-label", labels[state]);
      this.parts.toggle.title = labels[state];
    }
    this.parts.rate.textContent = `${audio.playbackRate}×`;
    this.parts.rate.setAttribute("aria-label", `${labels.speed}: ${audio.playbackRate}×`);
    (this.parts.volume as HTMLInputElement).value = String(audio.volume);

    const duration = isFinite(audio.duration) ? audio.duration : 0;
    const position = this.parts.position as HTMLInputElement;
    position.max = String(Math.floor(duration));
    position.disabled = duration === 0;
    if (!this.seeking) {
      position.value = String(Math.floor(audio.currentTime));
      position.setAttribute("aria-valuetext", `${formatTime(audio.currentTime)} / ${formatTime(duration || NaN)}`);
      this.parts.current.textContent = formatTime(audio.currentTime);
    }
    this.parts.duration.textContent = formatTime(duration || NaN);
  }
}

if (!customElements.get("pareto-audio-trigger")) customElements.define("pareto-audio-trigger", AudioTrigger);
if (!customElements.get("pareto-audio-bar")) customElements.define("pareto-audio-bar", AudioBar);
