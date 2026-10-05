import type { ApiRequest } from "./api";
import { curlCommand, execute } from "./api";
import { button, code, copyText, el, errorText, notice, updateNotice } from "./dom";
import { createOutput } from "./output";

export function createConsole(
  getRequest: () => ApiRequest,
  onComplete: () => void,
): {
  readonly actions: HTMLElement;
  readonly result: HTMLElement;
  readonly feedback: HTMLElement;
  readonly dispose: () => void;
} {
  let controller: AbortController | undefined;
  const result = createOutput();
  const feedback = notice();
  const actions = el("div", "request-actions");
  const cancel = button(
    "Annuler",
    () => {
      controller?.abort();
    },
    "danger",
  );
  cancel.hidden = true;
  const curl = code("");
  curl.hidden = true;
  const copy = button("Copier cURL", () => {
    try {
      const command = curlCommand(getRequest());
      curl.textContent = command;
      curl.hidden = false;
      void copyText(command, copy);
      updateNotice(feedback, "Le cURL utilise $OAI_CODEX_TOKEN. Aucun jeton n’est copié.");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      updateNotice(feedback, errorText(error), true);
    }
  });
  const send = button(
    "Exécuter",
    () => {
      void run();
    },
    "primary",
  );
  const row = el("div", "cluster");
  row.append(send, cancel, copy);
  actions.append(row, curl);

  async function run(): Promise<void> {
    if (controller) return;
    try {
      const request = getRequest();
      controller = new AbortController();
      send.disabled = true;
      send.textContent = "En cours…";
      cancel.hidden = false;
      copy.disabled = true;
      updateNotice(feedback, "");
      result.reset();
      const response = await execute(request, controller, result.event);
      result.complete(response);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const message = controller?.signal.aborted
        ? "Requête interrompue. La sortie reçue est conservée."
        : errorText(error);
      result.fail(message);
      updateNotice(feedback, message, true);
    } finally {
      controller = undefined;
      send.disabled = false;
      send.textContent = "Exécuter";
      cancel.hidden = true;
      copy.disabled = false;
      onComplete();
    }
  }
  return {
    actions,
    result: result.root,
    feedback,
    dispose: () => {
      controller?.abort();
      result.dispose();
    },
  };
}
