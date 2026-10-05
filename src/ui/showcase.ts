import { badge, button, code, el, empty, field, notice, panel } from "./dom";

export function renderShowcase(root: HTMLElement): void {
  const container = el("main", "showcase");
  container.append(
    el("h1", "", "Primitives · oai-codex serve"),
    el("p", "muted", "Contrôles réutilisés dans le tableau de bord."),
  );
  const controls = panel("Actions et états");
  const cluster = el("div", "cluster");
  cluster.append(
    button("Exécuter", () => {}, "primary"),
    button("Copier cURL", () => {}),
    button("Annuler", () => {}, "danger"),
  );
  const loading = button("En cours…", () => {});
  loading.disabled = true;
  cluster.append(loading, badge("Connecté", "success"), badge("À vérifier", "warning"));
  controls.body.append(cluster);
  const grid = el("div", "showcase-grid");
  const inputPanel = panel("Formulaire");
  const input = el("input");
  input.placeholder = "Jeton du serveur";
  const invalid = el("textarea", "mono");
  invalid.value = '{ "model": }';
  invalid.setAttribute("aria-invalid", "true");
  inputPanel.body.classList.add("stack");
  inputPanel.body.append(
    field("Accès", input, "Conservé dans cet onglet."),
    field("Requête JSON", invalid),
    notice("Le JSON n’est pas valide.", true),
  );
  const output = panel("Réponse");
  output.body.append(
    empty(
      "La réponse apparaîtra ici",
      "Exécutez une requête pour recevoir les événements du serveur.",
    ),
    code('{ "status": "exemple de composant" }'),
  );
  grid.append(inputPanel.root, output.root);
  container.append(controls.root, grid);
  root.replaceChildren(container);
}
