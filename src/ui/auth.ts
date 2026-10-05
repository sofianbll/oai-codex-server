import type { PublicStatus } from "../shared/contracts";
import { clearToken, getStatus, getToken, setToken } from "./api";
import { button, el, errorText, field, notice, panel, updateNotice } from "./dom";

export function renderLogin(root: HTMLElement, connected: (status: PublicStatus) => void): void {
  const layout = el("main", "login-shell");
  const intro = el("div", "stack login-intro");
  intro.append(
    el("span", "brand-word", "oai-codex"),
    el("h1", "", "Votre console API."),
    el(
      "p",
      "muted",
      "Connectez-vous au proxy pour tester les modèles, suivre les requêtes et consulter le contrat.",
    ),
  );
  const view = panel("Accès au serveur", window.location.host);
  const form = el("form", "stack");
  const token = el("input");
  token.type = "password";
  token.autocomplete = "off";
  token.required = true;
  token.placeholder = "Jeton d’accès oai-codex";
  token.value = getToken();
  const feedback = notice();
  const submit = button("Se connecter", () => {}, "primary");
  submit.type = "submit";
  form.append(
    field("Jeton du serveur", token, "Conservé uniquement pendant la session de cet onglet."),
    feedback,
    submit,
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void login();
  });
  view.body.append(form);
  layout.append(
    intro,
    view.root,
    el(
      "p",
      "muted small",
      "Le jeton du proxy est distinct de votre session Codex. Les identifiants Codex restent sur le serveur.",
    ),
  );
  root.replaceChildren(layout);
  async function login(): Promise<void> {
    submit.disabled = true;
    submit.textContent = "Connexion…";
    try {
      setToken(token.value.trim());
      const status = await getStatus();
      token.value = "";
      connected(status);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      clearToken();
      updateNotice(feedback, errorText(error), true);
      submit.disabled = false;
      submit.textContent = "Se connecter";
    }
  }
}
