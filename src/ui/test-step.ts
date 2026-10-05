import type { PublicStatus } from "../shared/contracts";
import { execute, RequestError, type StreamEvent } from "./api";
import { button, el, errorText, field, link, notice, panel, updateNotice } from "./dom";
import { jsonObject } from "./schemas";
import { createTestResult } from "./test-result";
import type { TestScenario } from "./test-scenarios";
import { evaluateResult } from "./test-verdict";

export type StepState = "Non testé" | "En cours" | "Réussi" | "Échec" | "Bloqué" | "À évaluer";
type StepContext = {
  readonly status: PublicStatus;
  readonly models: readonly string[];
  readonly modelError: string;
  readonly index: number;
  readonly onState: (state: StepState) => void;
  readonly next: () => void;
};
export function createTestStep(scenario: TestScenario, context: StepContext) {
  const root = el("div", "stack test-step");
  const heading = el(
    "h2",
    "test-title",
    `${String(context.index + 1).padStart(2, "0")}. ${scenario.title}`,
  );
  heading.tabIndex = -1;
  const intro = el("div", "stack");
  intro.append(
    el("span", "small muted", "RESPONSES · TEST GUIDÉ"),
    heading,
    el("p", "muted", scenario.description),
  );
  const expected = notice(`À vérifier : ${scenario.expected}`);
  root.append(intro, expected);
  if (scenario.blocked) {
    root.append(
      notice(`Bloqué · ${scenario.blocked}`),
      link("Ouvrir l’Explorateur API", "#explorer"),
      button("Étape suivante", context.next),
    );
    return { root, focus: () => heading.focus(), dispose: () => {} };
  }
  const request = panel("Votre essai", "Modifiez les données, puis lancez le test.");
  request.body.classList.add("stack");
  const model = el("select");
  for (const id of context.models) {
    const option = el("option", "", id);
    option.value = id;
    model.append(option);
  }
  if (context.models.includes(context.status.upstream.defaultModel))
    model.value = context.status.upstream.defaultModel;
  const simple = typeof scenario.body["input"] === "string";
  const prompt = el("textarea", "test-prompt");
  prompt.value = typeof scenario.body["input"] === "string" ? scenario.body["input"] : "";
  const target = el("input");
  target.value = scenario.expectedText ?? "";
  const instructions = el("textarea", "instructions");
  instructions.value =
    typeof scenario.body["instructions"] === "string" ? scenario.body["instructions"] : "";
  const raw = el("textarea", "mono raw-editor");
  raw.spellcheck = false;
  raw.value = JSON.stringify(scenario.body, null, 2);
  const custom = el("input");
  custom.type = "checkbox";
  const advanced = el("details", "contract-details");
  const rawField = field(
    "Corps JSON",
    raw,
    "Le modèle sélectionné ci-dessus est appliqué à l’envoi.",
  );
  rawField.hidden = simple;
  const customLabel = el("label", "cluster");
  customLabel.append(custom, el("span", "", "Utiliser le JSON personnalisé"));
  advanced.append(
    el("summary", "", "Réglages et JSON"),
    field("Instructions", instructions),
    customLabel,
    rawField,
  );
  custom.checked = !simple;
  const promptField = field("Votre message", prompt);
  promptField.hidden = !simple;
  request.body.append(field("Modèle", model), promptField);
  if (scenario.check === "exact")
    request.body.append(
      field(
        "Texte attendu exactement",
        target,
        "Modifiez aussi cette valeur si vous changez la consigne.",
      ),
    );
  if (!simple) advanced.open = true;
  request.body.append(advanced);
  const result = createTestResult();
  const feedback = notice();
  feedback.dataset["testid"] = "test-feedback";
  const send = button(
    "Lancer le test",
    () => {
      void run();
    },
    "primary",
  );
  const stop = button("Interrompre", () => controller?.abort(), "danger");
  stop.hidden = true;
  const next = button(context.index === 0 ? "Passer au streaming" : "Étape suivante", context.next);
  const manual = el("div", "cluster");
  manual.hidden = true;
  manual.append(
    button("Consigne respectée", () => {
      result.judge(true);
      context.onState("Réussi");
    }),
    button("Consigne non respectée", () => {
      result.judge(false);
      context.onState("Échec");
    }),
  );
  const actions = el("div", "cluster");
  actions.append(send, stop);
  request.body.append(feedback, actions);
  root.append(request.root, result.root, manual, next);
  let controller: AbortController | undefined;
  let active = true;
  const controls = [model, prompt, target, instructions, raw, custom];
  const ready = context.models.length > 0 && context.status.auth.available;
  send.disabled = !ready;
  if (!ready) {
    context.onState("Bloqué");
    updateNotice(
      feedback,
      context.modelError ||
        "Session ou modèles indisponibles. Actualisez la page après avoir rétabli la connexion.",
      true,
    );
  }
  function invalidate(): void {
    result.reset();
    manual.hidden = true;
    send.textContent = "Lancer le test";
    updateNotice(feedback, "");
    context.onState(ready ? "Non testé" : "Bloqué");
  }
  for (const control of controls) control.addEventListener("input", invalidate);
  custom.addEventListener("change", () => {
    rawField.hidden = !custom.checked;
    promptField.hidden = custom.checked;
    instructions.disabled = custom.checked;
    if (custom.checked && simple)
      raw.value = JSON.stringify(
        { ...scenario.body, input: prompt.value, instructions: instructions.value },
        null,
        2,
      );
  });
  async function run(): Promise<void> {
    if (controller || !ready) return;
    try {
      if (!custom.checked && !prompt.value.trim())
        throw new RequestError(0, "Saisissez un message avant de lancer le test.");
      const body = custom.checked
        ? jsonObject.parse(JSON.parse(raw.value))
        : { ...scenario.body, input: prompt.value, instructions: instructions.value };
      if (body["input"] === "" || (Array.isArray(body["input"]) && body["input"].length === 0))
        throw new RequestError(0, "Ajoutez un message dans input.");
      const apiRequest = {
        method: scenario.method,
        path: scenario.path,
        body: { ...body, model: model.value },
      };
      controller = new AbortController();
      for (const control of controls) control.disabled = true;
      send.disabled = true;
      stop.hidden = false;
      next.disabled = true;
      manual.hidden = true;
      send.textContent = "En cours…";
      updateNotice(feedback, "Requête envoyée. Vous pouvez l’interrompre.");
      context.onState("En cours");
      result.start(apiRequest, context.status.upstream.mode);
      const events: StreamEvent[] = [];
      const response = await execute(apiRequest, controller, (event) => {
        if (active) {
          events.push(event);
          result.event(event);
        }
      });
      if (!active) return;
      controller.signal.throwIfAborted();
      const verdict = evaluateResult(
        { ...scenario, body: apiRequest.body, expectedText: target.value },
        { ...response, events },
      );
      result.complete(response, verdict);
      context.onState(
        verdict.technical === "failed" || verdict.behavior === "failed"
          ? "Échec"
          : verdict.behavior === "manual"
            ? "À évaluer"
            : "Réussi",
      );
      manual.hidden = verdict.technical !== "passed" || verdict.behavior !== "manual";
      updateNotice(feedback, "Test terminé. Consultez le résultat ci-dessous.");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (!active) return;
      const aborted = controller?.signal.aborted === true;
      const message = aborted
        ? "Flux interrompu côté navigateur. L’arrêt du calcul côté serveur n’est pas confirmé."
        : errorText(error);
      result.fail(message, aborted);
      context.onState(aborted ? "Non testé" : "Échec");
      updateNotice(feedback, message, true);
    } finally {
      controller = undefined;
      if (active) {
        for (const control of controls) control.disabled = false;
        instructions.disabled = custom.checked;
        send.disabled = false;
        send.textContent = "Réessayer";
        stop.hidden = true;
        next.disabled = false;
      }
    }
  }
  return {
    root,
    focus: () => heading.focus(),
    dispose: () => {
      active = false;
      controller?.abort();
    },
  };
}
