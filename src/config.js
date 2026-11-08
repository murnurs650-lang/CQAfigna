require("dotenv").config();

function clean(value) {
  const cleaned = String(value || "").trim().replace(/^["']|["']$/g, "");
  if (!cleaned || cleaned.includes("PASTE_YOUR") || cleaned === "sk-or-v1-...") return "";
  return cleaned;
}

const openaiKey = clean(process.env.OPENAI_API_KEY);
const openrouterKey = clean(process.env.OPENROUTER_API_KEY);
const aiProvider = openaiKey ? "openai" : openrouterKey ? "openrouter" : null;
const aiKey = aiProvider === "openai" ? openaiKey : openrouterKey;
const aiKeyFormatValid = !aiKey || aiProvider !== "openai" || aiKey.startsWith("sk-");
const configuredModel = clean(process.env.OPENAI_MODEL) || clean(process.env.OPENROUTER_MODEL);
const model = aiProvider === "openai"
  ? (configuredModel || "gpt-4.1-mini").replace(/^openai\//, "")
  : (configuredModel || "openai/gpt-4.1-mini").includes("/")
    ? (configuredModel || "openai/gpt-4.1-mini")
    : `openai/${configuredModel}`;

module.exports = {
  aiProvider,
  aiKey,
  aiKeyFormatValid,
  openrouterKey,
  openaiKey,
  chatEndpoint: aiProvider === "openai"
    ? "https://api.openai.com/v1/chat/completions"
    : process.env.OPENROUTER_URL || "https://openrouter.ai/api/v1/chat/completions",
  model,
  port: Number(process.env.PORT || 3000),
  datasetUrl: process.env.DATASET_API_URL || ""
};
