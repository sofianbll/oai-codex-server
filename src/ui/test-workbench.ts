import type { PublicStatus } from "../shared/contracts";
import { getModels } from "./api";
import { badge, button, el, errorText, link, notice } from "./dom";
import { scenarios } from "./test-scenarios";
import { createTestStep, type StepState } from "./test-step";
import "./test-workbench.css";

export function renderTestWorkbench(container: HTMLElement, status: PublicStatus): () => void {
  const layout = el("div", "test-workbench");
  const rail = el("details", "test-rail");
  rail.open = window.innerWidth >= 1024;
  const summary = el("summary", "", "Parcours Responses");
  const groups = el("nav", "test-groups");
  groups.setAttribute("aria-label", "Groupes API");
  const steps = el("nav", "test-steps");
  steps.setAttribute("aria-label", "Étapes Responses");
  const progress = el("p", "small muted");
  rail.append(summary, groups, progress, steps);
  const workspace = el("div", "test-workspace");
  layout.append(rail, workspace);
  container.append(layout);
  const lifetime = el(
    "p",
    "small muted",
    "Les essais restent disponibles pendant votre visite de Tests API. Quitter cette page efface les messages et résultats de cette visite.",
  );
  container.append(lifetime);
  const states = new Map<string, StepState>(
    scenarios.map((s) => [s.id, s.blocked ? "Bloqué" : "Non testé"]),
  );
  const cache = new Map<string, ReturnType<typeof createTestStep>>();
  let current = 0;
  let group = "Responses";
  let active = true;
  let models: readonly string[] = [];
  let modelError = "";
  let loaded = false;
  const groupButtons = new Map<string, HTMLButtonElement>();
  for (const name of ["Responses", "Images", "Audio", "Realtime", "Live"]) {
    const control = button(
      name,
      () => {
        if ([...states.values()].includes("En cours")) return;
        group = name;
        renderNav();
        show(false);
      },
      "ghost",
    );
    groupButtons.set(name, control);
    groups.append(control);
  }
  function renderNav(): void {
    for (const [name, control] of groupButtons) {
      control.setAttribute("aria-pressed", String(name === group));
      control.disabled = [...states.values()].includes("En cours");
    }
    progress.textContent = `${[...states.values()].filter((state) => state === "Réussi").length} / ${scenarios.length} étapes réussies`;
    steps.hidden = group !== "Responses";
    progress.hidden = steps.hidden;
    steps.replaceChildren();
    scenarios.forEach((scenario, index) => {
      const state = states.get(scenario.id) ?? "Non testé";
      const control = button(
        "",
        () => {
          current = index;
          renderNav();
          show(true);
        },
        "ghost",
      );
      control.classList.add("test-step-link");
      control.disabled = [...states.values()].includes("En cours");
      control.setAttribute("aria-current", index === current ? "step" : "false");
      control.append(
        el("span", "", `${String(index + 1).padStart(2, "0")}. ${scenario.title}`),
        badge(state, state === "Réussi" ? "success" : state === "Échec" ? "danger" : "neutral"),
      );
      steps.append(control);
    });
  }
  function show(focus: boolean): void {
    for (const child of Array.from(workspace.children)) {
      if (child instanceof HTMLElement) child.hidden = true;
    }
    if (group !== "Responses") {
      const other = el("section", "panel stack");
      other.append(
        el("h2", "", group),
        notice(
          "Le parcours guidé de ce groupe n’est pas encore disponible. Les opérations restent accessibles dans l’Explorateur.",
        ),
        link("Ouvrir l’Explorateur API", "#explorer"),
      );
      workspace.append(other);
      return;
    }
    const scenario = scenarios[current];
    if (!scenario) return;
    if (!loaded) {
      workspace.replaceChildren(notice("Chargement des modèles…"));
      return;
    }
    let step = cache.get(scenario.id);
    if (!step) {
      step = createTestStep(scenario, {
        status,
        models,
        modelError,
        index: current,
        onState: (state) => {
          if (active) {
            states.set(scenario.id, state);
            renderNav();
          }
        },
        next: () => {
          current = Math.min(current + 1, scenarios.length - 1);
          renderNav();
          show(true);
        },
      });
      cache.set(scenario.id, step);
      workspace.append(step.root);
    }
    step.root.hidden = false;
    summary.textContent = `Responses · ${String(current + 1).padStart(2, "0")} / ${scenarios.length}`;
    if (focus) {
      if (window.innerWidth < 1024) rail.open = false;
      step.focus();
    }
  }
  renderNav();
  show(false);
  void getModels()
    .then((items) => {
      models = items;
    })
    .catch((error: unknown) => {
      if (!(error instanceof Error)) throw error;
      modelError = `Modèles indisponibles : ${errorText(error)}`;
    })
    .finally(() => {
      if (active) {
        loaded = true;
        workspace.replaceChildren();
        show(false);
      }
    });
  return () => {
    active = false;
    for (const step of cache.values()) step.dispose();
  };
}
