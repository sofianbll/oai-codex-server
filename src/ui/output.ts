import type { ApiResult, StreamEvent } from "./api";
import { badge, button, code, copyText, el, empty, link, notice, panel, updateNotice } from "./dom";

export function createOutput(): {
  readonly root: HTMLElement;
  readonly reset: () => void;
  readonly event: (event: StreamEvent) => void;
  readonly complete: (result: ApiResult) => void;
  readonly fail: (message: string) => void;
  readonly dispose: () => void;
} {
  const view = panel("Réponse", "Sortie du serveur, reçue en direct");
  const tabs = el("div", "tabs");
  const output = code("");
  const events = code("");
  const raw = code("");
  const state = empty(
    "La réponse apparaîtra ici",
    "Envoyez une requête pour recevoir la sortie du modèle et inspecter ses événements.",
  );
  const feedback = notice();
  const metadata = el("div", "cluster");
  const media = el("div", "media-output");
  const copy = button(
    "Copier",
    () => {
      void copyText([output, events, raw].find((node) => !node.hidden)?.textContent ?? "", copy);
    },
    "ghost",
  );
  view.header.append(copy);
  const panes = [
    { title: "Texte", node: output },
    { title: "Événements", node: events },
    { title: "JSON", node: raw },
  ];
  for (const pane of panes) {
    const tab = button(
      pane.title,
      () => {
        for (const item of panes) item.node.hidden = item !== pane;
        for (const control of tabs.children)
          control.setAttribute("aria-pressed", String(control === tab));
      },
      "ghost",
    );
    tab.setAttribute("aria-pressed", String(pane === panes[0]));
    tabs.append(tab);
    pane.node.hidden = pane !== panes[0];
  }
  output.hidden = true;
  const outputBody = el("div", "output-body");
  outputBody.append(state, output, events, raw);
  view.body.classList.add("stack");
  view.body.append(tabs, outputBody, media, metadata, feedback);
  let count = 0;
  let hasText = false;
  let terminalFailure = "";
  let mediaUrl: string | undefined;
  return {
    root: view.root,
    reset: () => {
      count = 0;
      hasText = false;
      terminalFailure = "";
      if (mediaUrl) URL.revokeObjectURL(mediaUrl);
      mediaUrl = undefined;
      media.replaceChildren();
      state.hidden = true;
      output.textContent = "En attente du premier contenu…";
      events.textContent = "";
      raw.textContent = "";
      metadata.replaceChildren();
      for (const [index, pane] of panes.entries())
        pane.node.hidden = tabs.children[index]?.getAttribute("aria-pressed") !== "true";
      updateNotice(feedback, "Requête en cours…");
    },
    event: (event) => {
      count += 1;
      events.append(
        `${count.toString().padStart(3, "0")}  ${event.type ?? "event"}\n${JSON.stringify(event)}\n\n`,
      );
      raw.textContent = JSON.stringify(event.response ?? event, null, 2);
      if (
        event.type === "response.failed" ||
        event.type === "response.incomplete" ||
        event.type === "error"
      )
        terminalFailure = `Le serveur a renvoyé ${event.type}. Consultez le JSON pour le détail.`;
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        if (!hasText) output.textContent = "";
        hasText = true;
        output.append(event.delta);
      }
    },
    complete: (result) => {
      raw.textContent = result.data;
      if (result.binary) {
        mediaUrl = URL.createObjectURL(result.binary);
        const download = link("Télécharger la réponse", mediaUrl);
        download.download = "reponse-api";
        media.append(download);
        if (result.binary.type.startsWith("audio/")) {
          const audio = el("audio");
          audio.controls = true;
          audio.src = mediaUrl;
          media.append(audio);
        }
        if (result.binary.type.startsWith("image/")) {
          const image = el("img");
          image.alt = "Image renvoyée par l’API";
          image.src = mediaUrl;
          media.append(image);
        }
      }
      if (!hasText)
        output.textContent = result.streamed
          ? "Flux reçu. Consultez les événements ou le JSON pour examiner le contenu."
          : result.data;
      metadata.replaceChildren(
        badge(`HTTP ${result.status}`, terminalFailure ? "warning" : "success"),
        badge(`${(result.durationMs / 1000).toFixed(2)} s`),
        badge(`${count} événements`),
      );
      updateNotice(feedback, terminalFailure || "Requête terminée.", Boolean(terminalFailure));
    },
    fail: (message) => {
      updateNotice(feedback, message, true);
    },
    dispose: () => {
      if (mediaUrl) URL.revokeObjectURL(mediaUrl);
    },
  };
}
