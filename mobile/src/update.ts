/**
 * Noticing that a newer app has been deployed, without asking anybody.
 *
 * There is no service worker here, so nothing was watching: an installed PWA
 * kept running whatever build it had loaded, and Caddy's cache headers (added
 * alongside this) only decide what a *fresh* load gets. Between the two, a
 * deploy reached the phone whenever the phone happened to cold-start, which on
 * iOS can be days.
 *
 * What is compared is the bundle itself rather than a version number stamped at
 * build time. index.html names the script by a hash of its contents, so the
 * running app can read its own name off the document and ask the server what it
 * is serving now: if those differ, a different app is on the other end. No
 * build id to thread through the deploy, nothing that can disagree with the
 * artefact it describes, and it keeps working if the API is down — it is the
 * static host answering, which is the thing that changed.
 *
 * Cheap enough to be unremarkable: index.html is under two kilobytes, asked for
 * every quarter of an hour and when the app comes back to the foreground, which
 * is the moment somebody is about to use it.
 *
 * This module only reports. Whether to act on it is a question about what the
 * driver is in the middle of, and that is ChatScreen's business — see
 * useBuildWatch's caller.
 */
import { Platform } from "react-native";

/** Long enough to be invisible on a metered connection, short enough that a
 *  deploy reaches a phone that has been sitting on the passenger seat. */
const CHECK_INTERVAL_MS = 15 * 60 * 1000;

/** The script the running app was loaded from. Null anywhere that is not a
 *  browser, and on any document that does not look the way the export builds
 *  it — in which case this whole feature quietly does nothing. */
function runningBundle(): string | null {
  if (Platform.OS !== "web" || typeof document === "undefined") return null;
  const script = document.querySelector<HTMLScriptElement>(
    'script[src*="/_expo/static/js/web/"]'
  );
  return script?.getAttribute("src") ?? null;
}

/** What index.html says the app is, right now, on the server. */
async function deployedBundle(): Promise<string | null> {
  // no-store rather than no-cache: this request exists to find out whether
  // something changed, so a revalidated copy of the answer is no answer.
  const res = await fetch("/index.html", { cache: "no-store" });
  if (!res.ok) return null;
  const html = await res.text();
  return html.match(/\/_expo\/static\/js\/web\/[A-Za-z0-9._-]+\.js/)?.[0] ?? null;
}

/**
 * Watch for a newer build and call back once, when there is one.
 *
 * Returns a function that stops watching. Every failure is silence: no signal,
 * a static host that is briefly unhappy, a document this does not recognise —
 * none of them are worth a word to somebody driving, and the next check is
 * fifteen minutes away.
 */
export function watchForNewBuild(onNewBuild: () => void): () => void {
  const running = runningBundle();
  if (!running) return () => {};

  let stopped = false;

  const check = async () => {
    if (stopped) return;
    try {
      const deployed = await deployedBundle();
      // Compared by suffix: the document holds an absolute or a root-relative
      // src depending on how it was served, and both end in the same name.
      if (deployed && !running.endsWith(deployed)) {
        stopped = true;
        onNewBuild();
      }
    } catch {
      // Offline, or the host is restarting mid-deploy. Try again later.
    }
  };

  const timer = setInterval(check, CHECK_INTERVAL_MS);
  // The one moment worth checking outside the clock: the app being picked up
  // again. It is also when acting on the answer is least disruptive.
  const onVisible = () => {
    if (document.visibilityState === "visible") void check();
  };
  document.addEventListener("visibilitychange", onVisible);
  void check();

  return () => {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

/** Take the newer build. A plain reload: the shell is revalidated on every
 *  load now (see the Cache-Control block in deploy/Caddyfile), so what comes
 *  back is the deployed app rather than the one already in the cache. */
export function applyNewBuild(): void {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    window.location.reload();
  }
}
