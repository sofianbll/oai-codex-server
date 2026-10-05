export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

export function button(text: string, action: () => void, variant = "secondary"): HTMLButtonElement {
  const element = el("button", `button ${variant}`, text);
  element.type = "button";
  element.addEventListener("click", action);
  return element;
}

export function field(
  label: string,
  input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  hint = "",
): HTMLLabelElement {
  const wrapper = el("label", "field");
  wrapper.append(el("span", "field-label", label), input);
  if (hint) wrapper.append(el("span", "hint", hint));
  return wrapper;
}

export function panel(
  title: string,
  subtitle = "",
): { readonly root: HTMLElement; readonly body: HTMLDivElement; readonly header: HTMLElement } {
  const root = el("section", "panel");
  const header = el("header", "panel-header");
  const heading = el("div");
  heading.append(el("h2", "", title));
  if (subtitle) heading.append(el("p", "muted", subtitle));
  header.append(heading);
  const body = el("div", "panel-body");
  root.append(header, body);
  return { root, body, header };
}

export function notice(text = "", error = false): HTMLParagraphElement {
  const result = el("p", `notice${error ? " error" : ""}`, text);
  result.setAttribute("role", error ? "alert" : "status");
  result.hidden = text.length === 0;
  return result;
}

export function updateNotice(node: HTMLElement, text: string, error = false): void {
  node.textContent = text;
  node.hidden = text.length === 0;
  node.classList.toggle("error", error);
  node.setAttribute("role", error ? "alert" : "status");
}

export function badge(text: string, tone = "neutral"): HTMLSpanElement {
  return el("span", `badge ${tone}`, text);
}

export function code(text: string): HTMLPreElement {
  const node = el("pre", "code", text);
  node.tabIndex = 0;
  return node;
}

export function empty(title: string, detail: string): HTMLDivElement {
  const node = el("div", "empty");
  node.append(el("span", "empty-glyph", "{ }"), el("h3", "", title), el("p", "muted", detail));
  return node;
}

export function link(text: string, href: string): HTMLAnchorElement {
  const node = el("a", "button secondary", text);
  node.href = href;
  return node;
}

export function rows(items: readonly (readonly [string, string])[]): HTMLDListElement {
  const list = el("dl", "key-values");
  for (const [label, value] of items)
    list.append(el("dt", "muted", label), el("dd", "mono", value));
  return list;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Une erreur inattendue est survenue.";
}

export async function copyText(text: string, target: HTMLButtonElement): Promise<void> {
  const original = target.textContent;
  try {
    await navigator.clipboard.writeText(text);
    target.textContent = "Copié";
  } catch (error) {
    target.textContent = error instanceof Error ? "Copie indisponible" : "Erreur de copie";
  }
  window.setTimeout(() => {
    target.textContent = original;
  }, 1800);
}
