import type { JsonObject } from "./schemas";

export type TestScenario = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly expected: string;
  readonly path: string;
  readonly method: string;
  readonly body: JsonObject;
  readonly check: "exact" | "json" | "text" | "tokens" | "compact" | "manual";
  readonly expectedText?: string;
  readonly blocked?: string;
};
const base = { path: "/v1/responses", method: "POST" } as const;
const input = { input: "Réponds exactement : TEST_OK", stream: false, store: false } as const;
const prerequisite =
  "Un identifiant de réponse conservée est requis. Les essais utilisent store:false ; configurez ce prérequis dans l’Explorateur avant de vérifier cette opération.";

export const scenarios: readonly TestScenario[] = [
  {
    ...base,
    id: "simple",
    title: "Réponse simple",
    description: "Envoyer une instruction courte sans streaming.",
    expected: "Réponse terminée contenant exactement TEST_OK.",
    body: input,
    check: "exact",
    expectedText: "TEST_OK",
  },
  {
    ...base,
    id: "streaming",
    title: "Streaming SSE",
    description: "Observer les événements jusqu’à response.completed.",
    expected: "Flux terminé et texte exactement TEST_OK.",
    body: { ...input, stream: true },
    check: "exact",
    expectedText: "TEST_OK",
  },
  {
    ...base,
    id: "instructions",
    title: "Instructions",
    description: "Tester la consigne de niveau développeur.",
    expected: "Texte exactement INSTRUCTION_OK.",
    body: {
      ...input,
      instructions: "Réponds toujours exactement INSTRUCTION_OK.",
      input: "Bonjour",
    },
    check: "exact",
    expectedText: "INSTRUCTION_OK",
  },
  {
    ...base,
    id: "structured",
    title: "JSON structuré",
    description: "Demander un objet conforme à un schéma strict.",
    expected: "Objet JSON contenant uniquement ok:true.",
    body: {
      ...input,
      input: "Retourne un objet avec ok égal à true.",
      text: {
        format: {
          type: "json_schema",
          name: "test_result",
          strict: true,
          schema: {
            type: "object",
            properties: { ok: { type: "boolean", const: true } },
            required: ["ok"],
            additionalProperties: false,
          },
        },
      },
    },
    check: "json",
  },
  {
    ...base,
    id: "conversation",
    title: "Conversation",
    description: "Renvoyer explicitement l’historique, sans stockage serveur.",
    expected: "Le modèle retrouve le code CONTEXT_OK.",
    body: {
      ...input,
      input: [
        { role: "user", content: "Le code est CONTEXT_OK." },
        { role: "assistant", content: "Compris." },
        { role: "user", content: "Réponds uniquement avec le code." },
      ],
    },
    check: "exact",
    expectedText: "CONTEXT_OK",
  },
  {
    ...base,
    id: "image",
    title: "Image",
    description: "Vérifier la compréhension d’une image fournie.",
    expected: "Description cohérente avec l’image, à contrôler visuellement.",
    body: {
      ...input,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Décris cette image." },
            { type: "input_image", image_url: "REMPLACER_PAR_URL_OU_DATA_URL" },
          ],
        },
      ],
    },
    check: "manual",
    blocked:
      "Ajoutez une vraie image (URL accessible ou data URL) dans l’Explorateur avant l’envoi.",
  },
  {
    ...base,
    id: "document",
    title: "Document",
    description: "Vérifier la lecture d’un document fourni.",
    expected: "Résumé fidèle au document, à contrôler manuellement.",
    body: {
      ...input,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Résume ce document." },
            { type: "input_file", file_id: "REMPLACER_PAR_FILE_ID" },
          ],
        },
      ],
    },
    check: "manual",
    blocked: "Joignez un document réel et son file_id dans l’Explorateur avant l’envoi.",
  },
  {
    ...base,
    id: "function",
    title: "Appel de fonction",
    description:
      "Première étape de la boucle outil. Ensuite, exécuter la fonction et renvoyer function_call_output avec le même call_id et l’historique dans l’Explorateur.",
    expected: "Appel get_weather ; la boucle complète reste à vérifier manuellement.",
    body: {
      ...input,
      input: "Quel temps fait-il à Paris ?",
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Obtenir la météo d’une ville.",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
            additionalProperties: false,
          },
          strict: true,
        },
      ],
      tool_choice: { type: "function", name: "get_weather" },
    },
    check: "manual",
  },
  {
    ...base,
    id: "reasoning",
    title: "Raisonnement",
    description: "Demander une résolution avec effort de raisonnement.",
    expected: "Résultat 42 ; le raisonnement interne n’est pas exigé.",
    body: {
      ...input,
      input: "Calcule 6 × 7. Réponds seulement avec le nombre.",
      reasoning: { effort: "low" },
    },
    check: "exact",
    expectedText: "42",
  },
  {
    ...base,
    id: "count_tokens",
    path: "/v1/responses/input_tokens",
    title: "Compter les tokens",
    description: "Interroger le comptage sans générer de réponse.",
    expected: "Un entier input_tokens positif ou nul.",
    body: { input: "Bonjour" },
    check: "tokens",
  },
  {
    ...base,
    id: "compact",
    path: "/v1/responses/compact",
    title: "Compacter le contexte",
    description: "Soumettre un historique explicite au compactage.",
    expected: "Un objet response.compaction contenant un élément compaction.",
    body: {
      input: [
        { role: "user", content: "Mon code est CONTEXT_OK." },
        { role: "assistant", content: "Je retiens ce code." },
      ],
    },
    check: "compact",
  },
  {
    ...base,
    id: "retrieve",
    path: "/v1/responses/{response_id}",
    method: "GET",
    title: "Récupérer une réponse",
    description: "Nécessite une réponse persistée.",
    expected: "Réponse correspondant à l’identifiant fourni.",
    body: {},
    check: "manual",
    blocked: prerequisite,
  },
  {
    ...base,
    id: "input_items",
    path: "/v1/responses/{response_id}/input_items",
    method: "GET",
    title: "Lister les entrées",
    description: "Consulter les entrées d’une réponse persistée.",
    expected: "Liste des entrées de la réponse.",
    body: {},
    check: "manual",
    blocked: prerequisite,
  },
  {
    ...base,
    id: "cancel",
    path: "/v1/responses/{response_id}/cancel",
    title: "Annuler une réponse",
    description: "Nécessite une réponse en arrière-plan annulable.",
    expected: "État annulé pour la réponse ciblée.",
    body: {},
    check: "manual",
    blocked: `${prerequisite} La réponse doit être en arrière-plan et encore active.`,
  },
  {
    ...base,
    id: "delete",
    path: "/v1/responses/{response_id}",
    method: "DELETE",
    title: "Supprimer une réponse",
    description: "Supprimer une réponse persistée explicitement choisie.",
    expected: "Confirmation de suppression pour l’identifiant choisi.",
    body: {},
    check: "manual",
    blocked: prerequisite,
  },
  {
    ...base,
    id: "websocket",
    method: "GET",
    title: "WebSocket",
    description: "Connexion bidirectionnelle à tester avec une session dédiée.",
    expected: "Connexion puis cycle response.create terminé.",
    body: {},
    check: "manual",
    blocked:
      "Utilisez la fonction WebSocket de l’Explorateur pour établir et contrôler la session.",
  },
];
