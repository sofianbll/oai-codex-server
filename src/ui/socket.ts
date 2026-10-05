import { getToken } from "./api";
import { badge, button, code, el, errorText, field, notice, panel, updateNotice } from "./dom";
import { jsonObject } from "./schemas";

export function renderSocket(container: HTMLElement): () => void {
  const view = panel(
    "WebSocket Responses",
    "Échangez des trames avec le proxy. La disponibilité dépend de Codex.",
  );
  const endpoint = el("input", "mono");
  endpoint.value = "/v1/responses";
  const message = el("textarea", "mono");
  message.spellcheck = false;
  message.value = JSON.stringify(
    { type: "response.create", response: { input: "Bonjour", store: false } },
    null,
    2,
  );
  const feedback = notice("Déconnecté.");
  const log = code("");
  const actions = el("div", "cluster");
  let socket: WebSocket | undefined;
  let disposed = false;
  const connect = button("Connecter", open, "primary");
  const close = button("Fermer", () => {
    socket?.close(1000, "Fermeture demandée");
  });
  close.disabled = true;
  const send = button("Envoyer la trame", () => {
    try {
      socket?.send(JSON.stringify(jsonObject.parse(JSON.parse(message.value))));
      log.append(`ENVOI  ${message.value}\n\n`);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      updateNotice(feedback, errorText(error), true);
    }
  });
  send.disabled = true;
  actions.append(connect, close, send);
  view.header.append(badge("WebSocket", "warning"));
  view.body.classList.add("stack");
  view.body.append(
    field("Chemin WebSocket", endpoint),
    field("Trame JSON", message),
    actions,
    feedback,
    log,
  );
  container.replaceChildren(view.root);
  function open(): void {
    try {
      const url = new URL(endpoint.value, window.location.origin);
      if (url.origin !== window.location.origin || !url.pathname.startsWith("/v1/")) {
        updateNotice(feedback, "Utilisez un chemin /v1/ de ce serveur.", true);
        return;
      }
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url, ["oai-codex", `oai-codex-token.${getToken()}`]);
      connect.disabled = true;
      close.disabled = false;
      updateNotice(feedback, "Connexion en cours…");
      socket.addEventListener("open", () => {
        if (!disposed) {
          send.disabled = false;
          updateNotice(feedback, "WebSocket connecté.");
        }
      });
      socket.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (disposed) return;
        log.append(
          `REÇU  ${typeof event.data === "string" ? event.data : "Trame binaire reçue"}\n\n`,
        );
      });
      socket.addEventListener("error", () => {
        if (!disposed)
          updateNotice(
            feedback,
            "Connexion WebSocket refusée ou interrompue. Consultez le serveur pour le détail.",
            true,
          );
      });
      socket.addEventListener("close", (event) => {
        if (disposed) return;
        log.append(`FERMÉ  code ${event.code}${event.reason ? ` · ${event.reason}` : ""}\n\n`);
        connect.disabled = false;
        send.disabled = true;
        close.disabled = true;
        updateNotice(
          feedback,
          `Connexion fermée · code ${event.code}${event.reason ? ` · ${event.reason}` : ""}`,
          event.code !== 1000,
        );
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      updateNotice(feedback, errorText(error), true);
    }
  }
  return () => {
    disposed = true;
    socket?.close(1000, "Changement de page");
  };
}
