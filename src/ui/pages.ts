import type { PublicStatus } from "../shared/contracts";
import { getActivity, getConfig, saveConfig } from "./api";
import {
  badge,
  button,
  code,
  copyText,
  el,
  empty,
  errorText,
  field,
  link,
  notice,
  panel,
  rows,
  updateNotice,
} from "./dom";
import { configSchema } from "./schemas";

export function renderActivity(container: HTMLElement): () => void {
  const view = panel("Journal des requêtes", "Métadonnées du serveur, sans message ni secret");
  container.append(view.root);
  let active = true;
  const refresh = button("Actualiser", () => {
    void load();
  });
  view.header.append(refresh);
  async function load(): Promise<void> {
    refresh.disabled = true;
    try {
      const entries = await getActivity();
      if (!active) return;
      if (entries.length === 0) {
        view.body.replaceChildren(
          empty(
            "Aucune requête pour le moment",
            "Les appels au proxy apparaîtront ici après leur exécution.",
          ),
        );
        return;
      }
      const table = el("table", "activity-table");
      const head = el("thead");
      const heading = el("tr");
      for (const label of ["Requête", "État", "HTTP", "Durée", "Taille", "Heure"])
        heading.append(el("th", "", label));
      head.append(heading);
      const body = el("tbody");
      const states = {
        active: "En cours",
        completed: "Terminée",
        aborted: "Annulée",
        failed: "Échec",
      } as const;
      for (const entry of entries) {
        const row = el("tr");
        const route = el("td");
        route.append(badge(entry.method), el("span", "mono", entry.path));
        row.append(
          route,
          el("td", "", states[entry.state]),
          el("td", "mono", entry.status ? String(entry.status) : "En attente"),
          el("td", "mono", `${entry.durationMs} ms`),
          el("td", "mono", `${entry.bytes} o`),
          el("td", "", new Date(entry.startedAt).toLocaleTimeString("fr-FR")),
        );
        body.append(row);
      }
      table.append(head, body);
      const scroll = el("div", "table-scroll");
      scroll.tabIndex = 0;
      scroll.setAttribute("aria-label", "Journal des requêtes");
      scroll.append(table);
      view.body.replaceChildren(scroll);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (active) view.body.replaceChildren(notice(errorText(error), true));
    } finally {
      refresh.disabled = false;
    }
  }
  void load();
  return () => {
    active = false;
  };
}

export function renderConfiguration(container: HTMLElement, status: PublicStatus): () => void {
  const runtime = panel("Serveur actif", "Valeurs utilisées par le processus en cours");
  runtime.body.append(
    rows([
      ["Écoute", `${status.network.bind}:${status.network.port}`],
      ["Adresses", status.network.addresses.join("\n")],
      ["Upstream", status.upstream.origin],
      ["Traduction", status.upstream.mode],
      ["Modèle par défaut", status.upstream.defaultModel],
      ["Session Codex", status.auth.available ? "Disponible" : "Non disponible"],
      ["Version", status.version],
    ]),
  );
  const saved = panel(
    "Configuration enregistrée",
    "Les changements seront appliqués au prochain démarrage.",
  );
  container.append(runtime.root, saved.root);
  let active = true;
  const editor = el("textarea", "mono config-editor");
  editor.spellcheck = false;
  const feedback = notice();
  const save = button(
    "Enregistrer",
    () => {
      void persist();
    },
    "primary",
  );
  const copy = button("Copier JSON", () => {
    void copyText(editor.value, copy);
  });
  const actions = el("div", "cluster");
  actions.append(save, copy);
  saved.body.classList.add("stack");
  saved.body.append(
    field(
      "Configuration JSON",
      editor,
      "Les identifiants Codex restent sur le serveur et ne sont jamais exposés ici.",
    ),
    feedback,
    actions,
  );
  save.disabled = true;
  void getConfig()
    .then((config) => {
      if (active) {
        editor.value = JSON.stringify(config, null, 2);
        save.disabled = false;
      }
    })
    .catch((error: unknown) => {
      if (active) updateNotice(feedback, errorText(error), true);
    });
  async function persist(): Promise<void> {
    save.disabled = true;
    try {
      const result = await saveConfig(configSchema.parse(JSON.parse(editor.value)));
      if (active) {
        editor.value = JSON.stringify(result.config, null, 2);
        updateNotice(
          feedback,
          result.restartRequired
            ? "Configuration enregistrée. Redémarrez oai-codex serve pour l’appliquer."
            : "Configuration enregistrée.",
        );
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (active) updateNotice(feedback, errorText(error), true);
    } finally {
      save.disabled = false;
    }
  }
  return () => {
    active = false;
  };
}

export function renderDocumentation(container: HTMLElement): void {
  const docs = panel("Le contrat, au même endroit", "Référence interactive servie par ce proxy");
  docs.body.classList.add("stack");
  docs.body.append(
    el(
      "p",
      "muted",
      "La documentation Scalar décrit les routes, leurs paramètres et les exemples. Son client utilise le jeton d’accès de ce serveur, à renseigner dans l’authentification Bearer.",
    ),
  );
  const actions = el("div", "cluster");
  actions.append(link("Ouvrir Scalar", "/docs"), link("Ouvrir OpenAPI", "/openapi.json"));
  docs.body.append(actions);
  const connect = panel("Utiliser le proxy dans votre client", "URL de base compatible OpenAI");
  connect.body.classList.add("stack");
  connect.body.append(
    rows([
      ["Base URL", `${window.location.origin}/v1`],
      ["Authentification", "Authorization: Bearer $OAI_CODEX_TOKEN"],
    ]),
    code(
      `curl '${window.location.origin}/v1/models' \\\n  -H "Authorization: Bearer $OAI_CODEX_TOKEN"`,
    ),
    notice(
      "Les capacités marquées « À vérifier » sont transmises à Codex. Leur présence ne garantit pas leur prise en charge par l’upstream.",
    ),
  );
  container.append(docs.root, connect.root);
}
