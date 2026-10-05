import type { PublicStatus } from "../shared/contracts";
import { clearToken, getStatus } from "./api";
import { badge, button, el, errorText, notice, updateNotice } from "./dom";
import { renderExplorer } from "./explorer";
import { icon } from "./icons";
import { renderActivity, renderConfiguration, renderDocumentation } from "./pages";
import { renderShowcase } from "./showcase";
import { renderTestWorkbench } from "./test-workbench";

const routes = [
  {
    id: "tests",
    title: "Tests API",
    description: "Un test à la fois. Comprenez ce qui fonctionne, avec les échanges à l’appui.",
  },
  {
    id: "explorer",
    title: "Explorateur API",
    description: "Explorez et exécutez les opérations du proxy.",
  },
  {
    id: "activity",
    title: "Activité",
    description: "Retrouvez les appels et leurs résultats HTTP.",
  },
  {
    id: "configuration",
    title: "Configuration",
    description: "Consultez le serveur actif et préparez ses prochains réglages.",
  },
  {
    id: "documentation",
    title: "Documentation",
    description: "Le contrat OpenAPI et sa référence interactive.",
  },
] as const;

export function renderShell(
  root: HTMLElement,
  initialStatus: PublicStatus,
  disconnect: () => void,
): () => void {
  let status = initialStatus;
  let pageCleanup = (): void => {};
  let active = true;
  const shell = el("div", "app-shell");
  const skip = el("a", "skip-link", "Aller au contenu");
  skip.href = "#main";
  const sidebar = el("aside", "sidebar");
  const brand = el("div", "brand");
  brand.append(
    el("span", "brand-word", "oai-codex"),
    el("span", "brand-subtitle", "serve / console"),
  );
  const nav = el("nav", "nav");
  nav.setAttribute("aria-label", "Navigation principale");
  for (const route of routes) {
    const link = el("a", "nav-link");
    link.href = `#${route.id}`;
    link.append(icon(route.id === "tests" ? "playground" : route.id), el("span", "", route.title));
    nav.append(link);
  }
  const foot = el("div", "sidebar-foot");
  foot.append(
    el("span", "muted small", "Proxy Codex compatible OpenAI"),
    el("span", "mono muted small", `v${status.version}`),
  );
  sidebar.append(brand, nav, foot);
  const main = el("main", "main");
  main.id = "main";
  main.tabIndex = -1;
  const topbar = el("header", "topbar");
  const breadcrumb = el("div", "breadcrumb");
  breadcrumb.append(el("span", "mono", "Workspace"), el("span", "", "/"));
  const current = el("strong");
  breadcrumb.append(current);
  const connection = el("div", "cluster");
  const statusBadge = badge("", "success");
  connection.append(
    statusBadge,
    button(
      "Déconnexion",
      () => {
        clearToken();
        cleanup();
        disconnect();
      },
      "ghost",
    ),
  );
  topbar.append(breadcrumb, connection);
  const page = el("div", "page");
  const heading = el("div", "page-heading");
  const titleGroup = el("div");
  const title = el("h1");
  const subtitle = el("p");
  titleGroup.append(title, subtitle);
  const refresh = button("Actualiser", () => {
    void refreshStatus();
  });
  heading.append(titleGroup, refresh);
  const metrics = el("section", "metrics");
  metrics.setAttribute("aria-label", "État du serveur");
  const feedback = notice();
  const content = el("div", "page-content");
  page.append(heading, metrics, feedback, content);
  main.append(topbar, page);
  shell.append(sidebar, main);
  root.replaceChildren(skip, shell);

  function updateStatus(): void {
    statusBadge.textContent = status.auth.available
      ? "Session Codex disponible"
      : "Session Codex absente";
    statusBadge.className = `badge ${status.auth.available ? "success" : "warning"}`;
    const values = [
      ["Requêtes reçues", String(status.requests.total)],
      ["En cours", String(status.requests.active)],
      ["En échec", String(status.requests.failed)],
      ["Temps actif", formatUptime(status.uptimeSeconds)],
    ];
    metrics.replaceChildren();
    for (const [label, value] of values) {
      const metric = el("div", "metric");
      metric.append(el("span", "", label), el("strong", "mono", value));
      metrics.append(metric);
    }
  }
  async function refreshStatus(): Promise<void> {
    refresh.disabled = true;
    try {
      status = await getStatus();
      if (active) {
        updateStatus();
        updateNotice(feedback, "");
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (active) updateNotice(feedback, `État du serveur : ${errorText(error)}`, true);
    } finally {
      refresh.disabled = false;
    }
  }
  function navigate(): void {
    if (window.location.hash === "#main") return;
    if (window.location.hash === "#showcase") {
      cleanup();
      renderShowcase(document.getElementById("app") ?? main);
      return;
    }
    const route = routes.find((item) => `#${item.id}` === window.location.hash) ?? routes[0];
    pageCleanup();
    content.replaceChildren();
    current.textContent = route.title;
    title.textContent = route.title;
    subtitle.textContent = route.description;
    metrics.hidden = route.id === "tests";
    document.title = `${route.title} · oai-codex serve`;
    for (const link of nav.querySelectorAll("a")) {
      if (link.hash === `#${route.id}`) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    const renderers: Record<typeof route.id, () => () => void> = {
      tests: () => renderTestWorkbench(content, status),
      explorer: () =>
        renderExplorer(content, () => {
          void refreshStatus();
        }),
      activity: () => renderActivity(content),
      configuration: () => renderConfiguration(content, status),
      documentation: () => {
        renderDocumentation(content);
        return () => {};
      },
    };
    pageCleanup = renderers[route.id]();
    main.scrollTop = 0;
  }
  function cleanup(): void {
    active = false;
    pageCleanup();
    window.removeEventListener("hashchange", navigate);
    window.clearInterval(poll);
  }
  updateStatus();
  navigate();
  window.addEventListener("hashchange", navigate);
  const poll = window.setInterval(() => {
    if (document.visibilityState === "visible") void refreshStatus();
  }, 10_000);
  return cleanup;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
}
