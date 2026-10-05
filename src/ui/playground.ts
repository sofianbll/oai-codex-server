import { getModels, RequestError } from "./api";
import { createConsole } from "./console";
import { badge, button, el, errorText, field, notice, panel, updateNotice } from "./dom";
import { jsonObject } from "./schemas";

export function renderPlayground(container: HTMLElement, onComplete: () => void): () => void {
  const workbench = el("div", "workbench");
  const requestPanel = panel("Requête", "Générez une réponse avec votre session Codex");
  requestPanel.header.append(badge("POST /v1/responses"));
  const model = el("select");
  model.append(el("option", "", "Chargement des modèles…"));
  model.disabled = true;
  const modelState = notice();
  const prompt = el("textarea", "prompt-editor");
  prompt.placeholder = "Que souhaitez-vous demander au modèle ?";
  prompt.value = "Explique en trois phrases ce qu’est une API compatible OpenAI.";
  const instructions = el("textarea", "instructions");
  instructions.placeholder = "Ex. Réponds en français, de façon concise.";
  const raw = el("textarea", "mono raw-editor");
  raw.spellcheck = false;
  raw.value = "{}";
  let rawMode = false;
  const simple = el("div", "stack");
  const advanced = el("details", "contract-details");
  advanced.append(
    el("summary", "", "Instructions facultatives"),
    field("Instructions", instructions, "Le proxy complète les champs requis en mode minimal."),
  );
  simple.append(field("Modèle", model), modelState, field("Message", prompt), advanced);
  const rawField = field(
    "Corps de la requête JSON",
    raw,
    "Le corps est envoyé à /v1/responses. Activez stream pour recevoir les événements.",
  );
  rawField.hidden = true;
  const tabs = el("div", "tabs");
  const textTab = button(
    "Message",
    () => {
      rawMode = false;
      simple.hidden = false;
      rawField.hidden = true;
      textTab.setAttribute("aria-pressed", "true");
      jsonTab.setAttribute("aria-pressed", "false");
    },
    "ghost",
  );
  const jsonTab = button(
    "JSON brut",
    () => {
      if (!rawMode) raw.value = JSON.stringify(simpleRequest(), null, 2);
      rawMode = true;
      simple.hidden = true;
      rawField.hidden = false;
      jsonTab.setAttribute("aria-pressed", "true");
      textTab.setAttribute("aria-pressed", "false");
    },
    "ghost",
  );
  textTab.setAttribute("aria-pressed", "true");
  jsonTab.setAttribute("aria-pressed", "false");
  tabs.append(textTab, jsonTab);

  function simpleRequest() {
    return {
      model: model.value,
      input: prompt.value,
      instructions: instructions.value,
      stream: true,
    };
  }
  const requestConsole = createConsole(() => {
    if (!rawMode && model.disabled)
      throw new RequestError(0, "Choisissez un modèle disponible ou renseignez le JSON brut.");
    if (!rawMode && !prompt.value.trim())
      throw new RequestError(0, "Saisissez un message avant d’exécuter la requête.");
    const body = rawMode ? jsonObject.parse(JSON.parse(raw.value)) : simpleRequest();
    return { method: "POST", path: "/v1/responses", body };
  }, onComplete);
  requestPanel.body.classList.add("stack");
  requestPanel.body.append(tabs, simple, rawField, requestConsole.feedback, requestConsole.actions);
  workbench.append(requestPanel.root, requestConsole.result);
  container.append(workbench);
  let active = true;
  void getModels()
    .then((models) => {
      if (!active) return;
      model.replaceChildren();
      for (const id of models) {
        const option = el("option", "", id);
        option.value = id;
        model.append(option);
      }
      model.disabled = models.length === 0;
      if (models.length === 0)
        updateNotice(
          modelState,
          "Aucun modèle renvoyé. Le JSON brut permet de renseigner un identifiant.",
          true,
        );
    })
    .catch((error: unknown) => {
      if (active)
        updateNotice(
          modelState,
          `Modèles indisponibles : ${errorText(error)}. Utilisez le JSON brut pour renseigner le modèle.`,
          true,
        );
    });
  return () => {
    active = false;
    requestConsole.dispose();
  };
}
