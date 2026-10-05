import type { Operation } from "../shared/contracts";
import { getOperations } from "./api";
import { createBodyEditor } from "./body-editor";
import { createConsole } from "./console";
import { badge, el, errorText, field, notice, panel } from "./dom";
import { renderSocket } from "./socket";

const categoryOrder = ["Responses", "Models", "Images", "Audio", "Realtime", "Live"] as const;
const categoryDescriptions: Readonly<Record<string, string>> = {
  Responses: "Créer, lire, annuler et gérer les réponses du modèle",
  Models: "Lister et inspecter les modèles disponibles",
  Images: "Générer et modifier des images",
  Audio: "Synthèse vocale, transcription et gestion des voix",
  Realtime: "Sessions et appels temps réel (WebRTC)",
  Live: "Sessions Live et gestion des appels",
} as const;

const availability = {
  verified: "Vérifié",
  "source-backed": "Présent dans les sources",
  unverified: "À vérifier",
} as const;

export function renderExplorer(container: HTMLElement, onComplete: () => void): () => void {
  const layout = el("div", "explorer-layout");
  const catalog = panel("Opérations", "Routes du proxy et contrats connus");
  const search = el("input");
  search.type = "search";
  search.placeholder = "Rechercher une route…";
  const list = el("div", "operation-list");
  catalog.body.classList.add("stack");
  catalog.body.append(field("Filtrer les opérations", search), list);
  const workspace = el("div", "stack");
  layout.append(catalog.root, workspace);
  container.append(layout);
  let active = true;
  let disposeConsole = (): void => {};
  let selectedId = "";
  let operations: readonly Operation[] = [];

  function select(operation: Operation): void {
    disposeConsole();
    selectedId = operation.id;
    renderList();
    if (operation.id === "connectResponsesWebSocket") {
      disposeConsole = renderSocket(workspace);
      return;
    }
    const requestPanel = panel("Exécuter l’opération", operation.summary);
    requestPanel.header.append(
      badge(
        availability[operation.availability],
        operation.availability === "verified" ? "success" : "warning",
      ),
    );
    const method = el("select");
    for (const name of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      const option = el("option", "", name);
      option.value = name;
      method.append(option);
    }
    method.value = operation.method;
    const path = el("input", "mono");
    path.value = operation.path;
    const query = el("input", "mono");
    query.placeholder = "limit=10";
    const body = createBodyEditor(operation.requestBodyExample ?? {});
    const routeRow = el("div", "route-row");
    routeRow.append(field("Méthode", method), field("Chemin", path));
    const requestConsole = createConsole(() => {
      const url = new URL(path.value, window.location.origin);
      if (query.value.trim()) url.search = query.value;
      const withBody = !["GET", "HEAD"].includes(method.value);
      return {
        method: method.value,
        path: url.href,
        ...(withBody ? body.value() : {}),
      };
    }, onComplete);
    disposeConsole = requestConsole.dispose;
    const bodyField = body.root;
    const details = el("details", "contract-details");
    details.append(
      el("summary", "", "Détails du contrat et disponibilité"),
      el("p", "muted", operation.description),
    );
    const updateBody = (): void => {
      bodyField.hidden = ["GET", "HEAD"].includes(method.value);
    };
    method.addEventListener("change", updateBody);
    updateBody();
    requestPanel.body.classList.add("stack");
    requestPanel.body.append(details, routeRow);
    if (operation.pathParameters?.length)
      requestPanel.body.append(
        notice(`Remplacez les paramètres du chemin : ${operation.pathParameters.join(", ")}.`),
      );
    requestPanel.body.append(
      field("Paramètres de requête", query, operation.queryParameters?.join(", ") ?? "Facultatif"),
      bodyField,
      requestConsole.feedback,
      requestConsole.actions,
    );
    workspace.replaceChildren(requestPanel.root, requestConsole.result);
  }

  function renderList(): void {
    list.replaceChildren();
    const value = search.value.toLocaleLowerCase();
    const filtered = operations.filter((item) =>
      `${item.method} ${item.path} ${item.summary}`.toLocaleLowerCase().includes(value),
    );
    const grouped = new Map<string, Operation[]>();
    for (const op of filtered) {
      const group = grouped.get(op.category) ?? [];
      group.push(op);
      grouped.set(op.category, group);
    }
    const methodRank: Record<string, number> = { GET: 0, POST: 1, PUT: 2, PATCH: 3, DELETE: 4 };
    const orderedCategories = [
      ...categoryOrder.filter((cat) => grouped.has(cat)),
      ...[...grouped.keys()].filter((cat) => !(categoryOrder as readonly string[]).includes(cat)),
    ];
    for (const category of orderedCategories) {
      const ops = grouped.get(category);
      if (!ops?.length) continue;
      ops.sort(
        (a, b) =>
          (methodRank[a.method] ?? 5) - (methodRank[b.method] ?? 5) || a.path.localeCompare(b.path),
      );
      const header = el("div", "category-header");
      header.append(
        el("h3", "category-title", category),
        el("span", "small muted", categoryDescriptions[category] ?? ""),
      );
      list.append(header);
      for (const operation of ops) {
        const item = el("button", "operation");
        item.type = "button";
        item.setAttribute("aria-pressed", String(operation.id === selectedId));
        item.append(
          badge(operation.method),
          el("span", "mono", operation.path),
          el("span", "small muted", operation.summary),
        );
        item.addEventListener("click", () => select(operation));
        list.append(item);
      }
    }
    if (list.childElementCount === 0)
      list.append(el("p", "muted", "Aucune opération ne correspond."));
  }
  search.addEventListener("input", renderList);
  list.append(el("p", "muted", "Chargement du contrat…"));
  void getOperations()
    .then((items) => {
      if (!active) return;
      operations = items;
      if (items[0]) select(items[0]);
      else renderList();
    })
    .catch((error: unknown) => {
      if (active) list.replaceChildren(notice(errorText(error), true));
    });
  return () => {
    active = false;
    disposeConsole();
  };
}
