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
    const example = ["createResponse", "createChatCompletion"].includes(operation.id)
      ? { model: defaultModel, ...operation.requestBodyExample }
      : operation.requestBodyExample;
    let requestBody =
      body && media && example
        ? { ...body, content: { ...body.content, "application/json": { ...media, example } } }
        : body;
    if (operation.id === "create-realtime-call" && body && example) {
      requestBody = {
        ...body,
        content: {
          ...body.content,
          "application/json": {
            schema: {
              type: "object",
              required: ["sdp"],
              additionalProperties: false,
              properties: {
                sdp: { type: "string", minLength: 1 },
                session: {
                  type: "object",
                  additionalProperties: true,
                  not: { required: ["id"] },
                },
              },
            },
            example,
          },
        },
      };
    }
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
      description: `${operation.description}\n\nImplementation: ${operation.implementation}. Evidence (${operation.evidence.kind}, ${operation.evidence.date ?? "undated"}): ${operation.evidence.scope}\nPrerequisites: ${operation.prerequisites.join(" ")}\nLimitations: ${operation.limitations.join(" ")}\nSources: ${operation.evidence.sources.join(", ")}${source?.description ? `\n\nPublic contract reference:\n${source.description}` : ""}`,
      tags: [operation.category],
      security: localSecurity,
      "x-proxy-availability": operation.availability,
      "x-proxy-supported": operation.supported,
      "x-proxy-implementation": operation.implementation,
      "x-proxy-evidence": operation.evidence,
      "x-proxy-prerequisites": operation.prerequisites,
      "x-proxy-limitations": operation.limitations,
      ...(requestBody ? { requestBody } : {}),
      responses: source?.responses ?? {
        "101": {
          description:
            "WebSocket upgrade accepted; subsequent messages use the selected native protocol.",
        },
        "400": { description: "A WebSocket upgrade request is required." },
        ...(operation.id === "connectRealtimeWebSocket"
          ? {
              "501": {
                description:
                  "Minimal mode: realtime_protocol_not_adapted for the incompatible native V1 quicksilver intent. Raw mode remains a native relay.",
              },
            }
          : {}),
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
      description: `${transportDescription}\n\nThe reference covers the complete public Responses, Conversations, Models, Images, Audio, Realtime and Live families in the pinned source, Chat creation (minimal mode: restricted JSON text adaptation), plus the source-backed Responses WebSocket transport. Conversations are local durable objects in minimal mode, with the validated input subset and deletion limits documented per operation. Public schemas are retained verbatim and do not establish backend support. Duplicate ?beta=true source paths are omitted; query strings remain relayable except where an adaptation explicitly refuses them. Other /v1/* paths can be relayed even when absent from this reference; minimal-mode stored Chat operations are explicitly refused.\n\nUse the local server bearer token below. Never enter a Codex access token. The server reads Codex credentials privately.`,
    },
    servers: [{ url: "/" }],
    security: localSecurity,
    tags: [
      { name: "Responses", description: "Créer, lire, annuler et gérer les réponses du modèle." },
      {
        name: "Chat",
        description:
          "Adaptation JSON texte via Responses ; options non implémentées refusées explicitement.",
      },
      {
        name: "Conversations",
        description:
          "Historique local durable, distinct des Responses et de la continuité Codex. Supprimer le conteneur ne supprime pas ses items.",
      },
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
