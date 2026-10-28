const mobile = () => window.matchMedia("(max-width: 880px)").matches;
function closeMobileDrawer() {
  if (mobile()) document.getElementById("btn-close-drawer")?.click();
}
function wire() {
  const sidebar = document.getElementById("sidebar");
  const bar = document.getElementById("workspace-switch");
  const buttons = {
    chat: document.getElementById("view-chat"),
    activity: document.getElementById("view-activity"),
    files: document.getElementById("view-files")
  };
  const artVisible = () => {
    const el = document.querySelector(".aegis-art-backdrop");
    return !!el && getComputedStyle(el).display !== "none";
  };
  const activityVisible = () => !!document.querySelector(".aegis-activity-backdrop");
  const syncView = () => {
    const active = activityVisible() ? "activity" : artVisible() ? "files" : "chat";
    for (const [view, button] of Object.entries(buttons)) {
      if (view === active) button?.setAttribute("aria-current", "page");
      else button?.removeAttribute("aria-current");
    }
  };
  function show(view) {
    closeMobileDrawer();
    if (view !== "activity") window.__aegisActivity?.close();
    if (view !== "files") window.__aegisArtifacts?.close();
    if (view === "activity") void window.__aegisActivity?.open();
    if (view === "files") window.__aegisArtifacts?.open();
    syncView();
    if (view === "chat" && mobile()) buttons.chat?.focus({ preventScroll: true });
  }
  buttons.chat?.addEventListener("click", () => show("chat"));
  buttons.activity?.addEventListener("click", () => show("activity"));
  buttons.files?.addEventListener("click", () => show("files"));
  document.getElementById("btn-files")?.addEventListener("click", () => {
    if (mobile()) show("files");
    else window.__aegisArtifacts?.open();
    closeMobileDrawer();
  });
  document.getElementById("btn-memory")?.addEventListener("click", () => {
    closeMobileDrawer();
    window.__aegisMemory?.open();
  });
  document.getElementById("btn-activity")?.addEventListener("click", () => {
    if (mobile()) show("activity");
    else void window.__aegisActivity?.open();
    closeMobileDrawer();
  });
  document.getElementById("btn-changes")?.addEventListener("click", () => {
    const runtime = window.__aegisWeb;
    closeMobileDrawer();
    void window.__aegisChanges?.open(runtime?.state?.current?.cwd || "");
  });
  let artBackdrop = null;
  const artObserver = new MutationObserver(syncView);
  const bodyObserver = new MutationObserver(() => {
    const next = document.querySelector(".aegis-art-backdrop");
    if (next !== artBackdrop) {
      artObserver.disconnect();
      artBackdrop = next;
      if (next) artObserver.observe(next, { attributes: true, attributeFilter: ["style"] });
    }
    syncView();
  });
  bodyObserver.observe(document.body, { childList: true });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") queueMicrotask(syncView);
  });
  if (!sidebar || !bar) return;
  const syncViewport = () => {
    const app = document.querySelector(".app");
    if (!mobile()) {
      for (const el of [sidebar, app, bar]) {
        el?.style.removeProperty("--drawer-height");
        el?.style.removeProperty("--drawer-top");
        el?.style.removeProperty("--mobile-visible-height");
        el?.style.removeProperty("--mobile-visible-top");
      }
      document.documentElement.style.removeProperty("--mobile-visual-bottom");
      return;
    }
    const viewport = window.visualViewport;
    const height = Math.max(0, viewport?.height ?? window.innerHeight);
    const top = viewport?.offsetTop ?? 0;
    sidebar.style.setProperty("--drawer-height", `${height}px`);
    sidebar.style.setProperty("--drawer-top", `${top}px`);
    app?.style.setProperty("--mobile-visible-height", `${height}px`);
    app?.style.setProperty("--mobile-visible-top", `${top}px`);
    document.documentElement.style.setProperty("--mobile-visual-bottom", `${Math.max(0, window.innerHeight - height - top)}px`);
  };
  syncViewport();
  window.addEventListener("resize", syncViewport);
  window.visualViewport?.addEventListener("resize", syncViewport);
  window.visualViewport?.addEventListener("scroll", syncViewport);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire, { once: true });
else wire();
