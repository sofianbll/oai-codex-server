import type { ApiRequest, ApiResult, StreamEvent } from "./api";
import { badge, code, el, notice, panel, updateNotice } from "./dom";
import type { TestVerdict } from "./test-verdict";

export function createTestResult() {
  const view = panel(
    "Résultat",
    "Le transport et le respect de la consigne sont vérifiés séparément.",
  );
  const text = el("div", "test-response", "Votre réponse apparaîtra ici.");
  text.dataset["testid"] = "response-text";
  const verdicts = el("div", "test-verdicts");
  const technical = badge("Non testé");
  technical.dataset["testid"] = "technical";
  const behavior = badge("Non testé");
  behavior.dataset["testid"] = "behavior";
  for (const [label, value] of [
    ["Réponse technique", technical],
    ["Respect de la consigne", behavior],
  ] as const) {
    const row = el("div", "stack");
    row.append(el("span", "small muted", label), value);
    verdicts.append(row);
  }
  const feedback = notice();
  const metrics = el("div", "cluster");
  const details = el("details", "contract-details test-exchanges");
  const sent = code("");
  sent.dataset["testid"] = "sent-request";
  const raw = code("");
  const events = code("");
  const adaptation = el("p", "muted");
  details.append(
    el("summary", "", "Voir les échanges techniques"),
    el("h3", "", "Requête navigateur → proxy"),
    sent,
    el("h3", "", "Traitement du proxy"),
    adaptation,
    el("h3", "", "Événements reçus"),
    events,
    el("h3", "", "Réponse brute"),
    raw,
  );
  view.body.classList.add("stack");
  view.body.append(verdicts, text, metrics, feedback, details);
  let started = 0;
  let firstText: number | undefined;
  let count = 0;
  function state(node: HTMLElement, label: string, tone = "neutral"): void {
    node.textContent = label;
    node.className = `badge ${tone}`;
  }
  function reset(): void {
    state(technical, "Non testé");
    state(behavior, "Non testé");
    text.textContent = "Votre réponse apparaîtra ici.";
    metrics.replaceChildren();
    sent.textContent = "";
    raw.textContent = "";
    events.textContent = "";
    updateNotice(feedback, "");
    firstText = undefined;
    count = 0;
  }
  return {
    root: view.root,
    reset,
    start(request: ApiRequest, mode: string): void {
      reset();
      started = performance.now();
      state(technical, "En cours");
      text.textContent = "En attente de la réponse…";
      sent.textContent = JSON.stringify(request, null, 2);
      adaptation.textContent =
        mode === "minimal" && request.path === "/v1/responses"
          ? "Mode minimal : le proxy complète les champs absents, transforme input texte en message, refuse store:true et demande un flux à Codex. Sans streaming côté navigateur, il assemble la réponse finale. Explication issue de la configuration, pas une capture du trafic upstream."
          : `Mode ${mode} : cette requête est relayée sans adaptation Responses. Explication issue de la configuration, pas une capture du trafic upstream.`;
    },
    event(event: StreamEvent): void {
      count++;
      events.append(`${JSON.stringify(event)}\n`);
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        if (firstText === undefined) {
          firstText = performance.now() - started;
          text.textContent = "";
        }
        text.append(event.delta);
      }
    },
    complete(result: ApiResult, verdict: TestVerdict): void {
      raw.textContent = result.data;
      if (verdict.text) text.textContent = verdict.text;
      else if (firstText === undefined)
        text.textContent = "Aucun texte reçu. Consultez la réponse brute.";
      state(
        technical,
        verdict.technical === "passed" ? "Réussi" : "Échec",
        verdict.technical === "passed" ? "success" : "danger",
      );
      state(
        behavior,
        verdict.behavior === "manual"
          ? "À évaluer"
          : verdict.behavior === "passed"
            ? "Réussi"
            : "Échec",
        verdict.behavior === "passed" ? "success" : "warning",
      );
      updateNotice(feedback, verdict.detail, verdict.technical === "failed");
      metrics.append(
        badge(`HTTP ${result.status}`),
        badge(`${(result.durationMs / 1000).toFixed(2)} s`),
        badge(`${count} événements`),
      );
      if (firstText !== undefined)
        metrics.append(badge(`Premier texte : ${(firstText / 1000).toFixed(2)} s`));
    },
    fail(message: string, interrupted: boolean): void {
      state(technical, interrupted ? "Interrompu" : "Échec", "warning");
      state(behavior, "Non vérifié", "warning");
      raw.textContent = message;
      if (firstText === undefined) text.textContent = "Aucune réponse exploitable.";
      updateNotice(feedback, message, true);
    },
    judge(passed: boolean): void {
      state(
        behavior,
        passed ? "Réussi · manuel" : "Échec · manuel",
        passed ? "success" : "warning",
      );
    },
  };
}
