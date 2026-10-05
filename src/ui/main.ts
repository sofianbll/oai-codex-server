import "./styles.css";
import "./shell.css";
import { getStatus, getToken } from "./api";
import { renderLogin } from "./auth";
import { renderShell } from "./shell";
import { renderShowcase } from "./showcase";

export function startDashboard(root: HTMLElement): void {
  const showShowcase = (): boolean => {
    if (window.location.hash === "#showcase") {
      renderShowcase(root);
      return true;
    }
    return false;
  };
  if (showShowcase()) return;
  const login = (): void => {
    renderLogin(root, (status) => {
      renderShell(root, status, login);
    });
  };
  if (getToken()) {
    void getStatus()
      .then((status) => {
        if (showShowcase()) return;
        renderShell(root, status, login);
      })
      .catch((error: unknown) => {
        if (error instanceof Error) login();
        else throw error;
      });
  } else login();
}

const root = document.getElementById("app");
if (root) startDashboard(root);
