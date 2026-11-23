type ElmPorts = {
  sendCommand: {
    subscribe: (callback: (msg: { command: string; value: any }) => void) => void;
  };
  receiveMessage: {
    send: (msg: { messageType: string; value: any }) => void;
  };
};

type ElmApp = {
  ports: ElmPorts;
};

type VersionPayload = {
  gitVersion?: string;
  js?: string;
};

const VERSION_POLL_MS = 5 * 60 * 1000;

let waitingWorker: ServiceWorker | null = null;
let notifiedNewVersion = false;
let reloading = false;

function runningBundlePath(): string | null {
  const el = document.querySelector<HTMLScriptElement>(
    'script[type="module"][src*="/assets/index-"]'
  );
  if (!el) {
    return null;
  }
  try {
    return new URL(el.src, window.location.origin).pathname;
  } catch {
    return el.getAttribute("src");
  }
}

function notifyNewVersion(app: ElmApp): void {
  if (notifiedNewVersion) {
    return;
  }
  notifiedNewVersion = true;
  app.ports.receiveMessage.send({
    messageType: "newVersionAvailable",
    value: null,
  });
}

function reloadOnce(): void {
  if (reloading) {
    return;
  }
  reloading = true;
  window.location.reload();
}

export function reloadForNewVersion(): void {
  if (waitingWorker && navigator.serviceWorker) {
    // Reload once the new worker controls the page, with a fallback if
    // controllerchange never fires (e.g. the worker was already activated).
    navigator.serviceWorker.addEventListener("controllerchange", reloadOnce);
    waitingWorker.postMessage({ type: "SKIP_WAITING" });
    window.setTimeout(reloadOnce, 1500);
    return;
  }
  reloadOnce();
}

async function latestBundlePath(): Promise<string | null> {
  try {
    const response = await fetch("/version.json", { cache: "no-store" });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as VersionPayload;
    return payload.js || null;
  } catch {
    return null;
  }
}

// A waiting service worker is only news if the page runs an older bundle.
// HTML is fetched network-first, so after a plain reload the page already runs
// the newest bundle while the new worker still waits for all tabs to close.
// In that case activate it silently instead of showing the banner on every load.
async function handleWaitingWorker(
  app: ElmApp,
  worker: ServiceWorker,
  runningJs: string
): Promise<void> {
  const latestJs = await latestBundlePath();
  if (latestJs && latestJs === runningJs) {
    worker.postMessage({ type: "SKIP_WAITING" });
    return;
  }
  waitingWorker = worker;
  notifyNewVersion(app);
}

async function checkVersion(app: ElmApp, runningJs: string): Promise<void> {
  // Offline or older backends without /version.json yield null: no banner.
  const latestJs = await latestBundlePath();
  if (latestJs && latestJs !== runningJs) {
    notifyNewVersion(app);
  }
}

function startVersionPolling(app: ElmApp, runningJs: string): void {
  const maybeCheck = () => {
    if (document.visibilityState === "visible") {
      void checkVersion(app, runningJs);
    }
  };

  maybeCheck();
  window.setInterval(maybeCheck, VERSION_POLL_MS);
  document.addEventListener("visibilitychange", maybeCheck);
  window.addEventListener("online", maybeCheck);
}

function watchWaitingWorker(
  app: ElmApp,
  worker: ServiceWorker,
  runningJs: string
): void {
  if (worker.state === "installed" && navigator.serviceWorker.controller) {
    void handleWaitingWorker(app, worker, runningJs);
    return;
  }
  worker.addEventListener("statechange", () => {
    if (worker.state === "installed" && navigator.serviceWorker.controller) {
      void handleWaitingWorker(app, worker, runningJs);
    }
  });
}

async function registerServiceWorker(
  app: ElmApp,
  runningJs: string
): Promise<void> {
  try {
    const registration = await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
    });

    if (registration.waiting && navigator.serviceWorker.controller) {
      void handleWaitingWorker(app, registration.waiting, runningJs);
    }

    registration.addEventListener("updatefound", () => {
      if (registration.installing) {
        watchWaitingWorker(app, registration.installing, runningJs);
      }
    });

    window.setInterval(() => {
      void registration.update();
    }, VERSION_POLL_MS);
  } catch (error) {
    console.warn("Pareto service worker registration failed", error);
  }
}

export function initPwa(app: ElmApp): void {
  const runningJs = runningBundlePath();
  const canUseProductionPwa =
    Boolean(runningJs) && "serviceWorker" in navigator;

  if (runningJs) {
    startVersionPolling(app, runningJs);
  }

  if (!canUseProductionPwa || !runningJs) {
    return;
  }

  void registerServiceWorker(app, runningJs);
}
