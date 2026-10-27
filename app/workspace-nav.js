function closeMobileDrawer() {
  if (window.matchMedia("(max-width: 880px)").matches) {
    document.getElementById("btn-close-drawer")?.click();
  }
}
function wire() {
  document.getElementById("btn-files")?.addEventListener("click", () => {
    closeMobileDrawer();
    window.__aegisArtifacts?.open();
  });
  document.getElementById("btn-memory")?.addEventListener("click", () => {
    closeMobileDrawer();
    window.__aegisMemory?.open();
  });
  document.getElementById("btn-activity")?.addEventListener("click", () => {
    closeMobileDrawer();
    void window.__aegisActivity?.open();
  });
  document.getElementById("btn-changes")?.addEventListener("click", () => {
    const runtime = window.__aegisWeb;
    const cwd = runtime?.state?.current?.cwd;
    closeMobileDrawer();
    if (cwd) void window.__aegisChanges?.open(cwd);
    else void window.__aegisChanges?.open("");
  });
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;
  const syncDrawer = () => {
    if (!window.matchMedia("(max-width: 880px)").matches) {
      sidebar.style.removeProperty("--drawer-height");
      sidebar.style.removeProperty("--drawer-top");
      return;
    }
    const viewport = window.visualViewport;
    const height = viewport?.height ?? window.innerHeight;
    sidebar.style.setProperty("--drawer-height", `${Math.max(0, height)}px`);
    sidebar.style.setProperty("--drawer-top", `${viewport?.offsetTop ?? 0}px`);
  };
  syncDrawer();
  window.addEventListener("resize", syncDrawer);
  window.visualViewport?.addEventListener("resize", syncDrawer);
  window.visualViewport?.addEventListener("scroll", syncDrawer);
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wire, { once: true });
} else {
  wire();
}
