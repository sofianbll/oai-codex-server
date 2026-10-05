import { operations, publicApi, publicOperations, transportDescription } from "./catalog";

const localSecurity = [{ LocalBearer: [] }] as const;
const controls = [
  ["get", "/health", "getHealth", "Check process health", "Unauthenticated liveness probe."],
  [
    "get",
    "/api/status",
    "getServerStatus",
    "Read server status",
    "Read process, request, authentication availability and network status. Credentials are never returned.",
  ],
  [
    "get",
    "/api/config",
    "getServerConfig",
    "Read public configuration",
    "Read the safe configuration fields. Token values and credential locations are excluded.",
  ],
  [
    "put",
    "/api/config",
    "saveServerConfig",
    "Save configuration",
    "Save configuration for the next start. A restart is required; the running configuration remains unchanged.",
  ],
  [
    "get",
    "/api/capabilities",
    "getCapabilities",
    "List proxy operations",
    "List relayable operations with verified, source-backed or unverified backend evidence. supported=true describes local routing only.",
  ],
  [
    "get",
    "/api/activity",
    "getActivity",
    "Read request activity",
    "Read recent request metadata without request bodies or credentials.",
  ],
  [
    "post",
    "/api/server/stop",
    "stopServer",
    "Stop the server",
    "Request a graceful shutdown of the local server process.",
  ],
] as const;

export async function createOpenApi(defaultModel: string): Promise<Record<string, unknown>> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of operations) {
    const source = publicOperations.find(
      ({ definition }) => definition.operationId === operation.id,
    )?.definition;
    const body = source?.requestBody;
    const media = body?.content["application/json"];
    const example =
      operation.id === "createResponse"
        ? { model: defaultModel, ...operation.requestBodyExample }
        : operation.requestBodyExample;
    const requestBody =
      body && media && example
        ? { ...body, content: { ...body.content, "application/json": { ...media, example } } }
        : body;
    const definition = Object.fromEntries(
      Object.entries(source ?? {}).filter(
        ([key]) => !["servers", "security", "x-oaiMeta"].includes(key),
      ),
    );
    const path = paths[operation.path] ?? {};
    path[operation.method.toLowerCase()] = {
      ...definition,
      operationId: operation.id,
      summary: operation.summary,
      description: `${operation.description}${source?.description ? `\n\nPublic contract reference:\n${source.description}` : ""}`,
      tags: [operation.category],
      security: localSecurity,
      "x-proxy-availability": operation.availability,
      "x-proxy-supported": operation.supported,
      ...(requestBody ? { requestBody } : {}),
      responses: source?.responses ?? {
        "101": {
          description:
            "WebSocket upgrade accepted; subsequent messages use the Responses protocol.",
        },
        "400": { description: "A WebSocket upgrade request is required." },
        "502": { description: "The Codex backend could not establish the connection." },
      },
    };
    paths[operation.path] = path;
  }
  for (const [method, route, operationId, summary, description] of controls) {
    const path = paths[route] ?? {};
    path[method] = {
      operationId,
      summary,
      description,
      tags: ["Server"],
      security: route === "/health" ? [] : localSecurity,
      ...(method === "put"
        ? {
            requestBody: {
              required: true,
              content: {
                "application/json": { schema: { type: "object", additionalProperties: true } },
              },
            },
          }
        : {}),
      responses: {
        "200": {
          description: "Success",
          content: {
            "application/json": { schema: { type: "object", additionalProperties: true } },
          },
        },
      },
    };
    paths[route] = path;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "OAI Codex Server",
      version: "0.1.0",
      description: `${transportDescription}\n\nThe reference covers the complete public Responses, Models, Images, Audio, Realtime and Live families in the pinned source, plus the source-backed Responses WebSocket transport. Public schemas are retained verbatim and do not establish backend support. Duplicate ?beta=true source paths are omitted; query strings remain relayable. Other /v1/* paths can be relayed even when absent from this reference.\n\nUse the local server bearer token below. Never enter a Codex access token. The server reads Codex credentials privately.`,
    },
    servers: [{ url: "/" }],
    security: localSecurity,
    tags: [
      { name: "Responses", description: "Créer, lire, annuler et gérer les réponses du modèle." },
      { name: "Models", description: "Lister et inspecter les modèles disponibles." },
      { name: "Images", description: "Générer et modifier des images." },
      { name: "Audio", description: "Synthèse vocale, transcription et gestion des voix." },
      { name: "Realtime", description: "Sessions et appels temps réel (WebRTC)." },
      { name: "Live", description: "Sessions Live et gestion des appels." },
      { name: "Server", description: "Contrôle et surveillance du serveur local." },
    ],
    paths,
    components: {
      ...publicApi.components,
      securitySchemes: {
        LocalBearer: {
          type: "http",
          scheme: "bearer",
          description: "Local OAI Codex Server token. This is not the Codex/ChatGPT access token.",
        },
      },
    },
  };
}
