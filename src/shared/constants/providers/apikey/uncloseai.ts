/**
 * uncloseai API-key catalog entry. Kept out of gateways.ts so that frozen file
 * does not grow past its 1544-line ceiling (#14297).
 */
export const uncloseaiGateway = {
  uncloseai: {
    id: "uncloseai",
    serviceKinds: ["llm"],
    alias: "unc",
    name: "UncloseAI",
    icon: "auto_awesome",
    color: "#8B5CF6",
    textIcon: "UN",
    website: "https://uncloseai.com",
    passthroughModels: true,
    hasFree: true,
    noAuth: true,
    freeNote:
      "Free forever — no signup, no credit card. OpenAI-compatible endpoints. API accepts any non-empty string as key for identification. If older built-in models return 404, use Available Models → Import from /models or Auto-Sync; verified live model: Lorbus/Qwen3.6-27B-int4-AutoRound.",
    apiHint:
      "No auth required. API accepts any non-empty string as key for identification. If older built-in models return 404, use Available Models → Import from /models or Auto-Sync.",
    notice: {
      text: "UncloseAI needs no API key. API accepts any non-empty string as key for identification. If older built-in models return 404, use Available Models → Import from /models or Auto-Sync.",
    },
  },
} as const;
