import { el, field } from "./dom";
import type { JsonObject } from "./schemas";
import { jsonObject } from "./schemas";

export type RequestBody = {
  readonly body: JsonObject | FormData | string;
  readonly contentType?: string;
};

export function createBodyEditor(example: Readonly<Record<string, unknown>>): {
  readonly root: HTMLElement;
  readonly value: () => RequestBody;
} {
  const root = el("div", "stack");
  const mode = el("select");
  for (const [value, label] of [
    ["json", "JSON"],
    ["text", "Texte brut / SDP"],
    ["multipart", "Multipart avec fichier"],
  ]) {
    const option = el("option", "", label);
    option.value = value ?? "json";
    mode.append(option);
  }
  const body = el("textarea", "mono raw-editor");
  body.spellcheck = false;
  body.value = JSON.stringify(example, null, 2);
  const bodyField = field(
    "Corps de la requête",
    body,
    "Pour Multipart, saisissez les champs sous forme d’objet JSON.",
  );
  const contentType = el("input");
  contentType.value = "text/plain";
  const contentTypeField = field("Content-Type", contentType);
  const file = el("input");
  file.type = "file";
  const fileName = el("input");
  fileName.value = "file";
  const upload = el("div", "stack");
  upload.append(field("Nom du champ fichier", fileName), field("Fichier à envoyer", file));
  const update = (): void => {
    upload.hidden = mode.value !== "multipart";
    contentTypeField.hidden = mode.value !== "text";
  };
  mode.addEventListener("change", update);
  update();
  root.append(field("Format du corps", mode), bodyField, contentTypeField, upload);
  return {
    root,
    value: () => {
      if (mode.value === "text") return { body: body.value, contentType: contentType.value };
      const data = jsonObject.parse(JSON.parse(body.value));
      if (mode.value === "multipart") {
        const form = new FormData();
        for (const [key, value] of Object.entries(data))
          form.append(key, typeof value === "string" ? value : JSON.stringify(value));
        for (const item of file.files ?? []) form.append(fileName.value, item);
        return { body: form };
      }
      return { body: data };
    },
  };
}
