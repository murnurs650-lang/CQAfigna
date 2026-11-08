const fs = require("fs");
const path = require("path");
const config = require("./config");

const ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const MIME_TYPES = {
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".webm": "audio/webm"
};
const LANGUAGES = { EN: "en", KZ: "kk", RU: "ru" };

function transcriptFromSegments(result, startedAt) {
  const segments = Array.isArray(result.segments) && result.segments.length
    ? result.segments
    : result.text ? [{ start: 0, text: result.text }] : [];
  return segments.map(segment => {
    const start = Number(segment.start);
    const at = Number.isFinite(start) ? start : 0;
    return {
      timestamp: new Date(startedAt + at * 1000).toISOString(),
      speaker: "unknown",
      text: String(segment.text || "").trim()
    };
  }).filter(message => message.text);
}

async function transcribeAudioFile(filePath, language) {
  if (!config.openaiKey) {
    const error = new Error("Для распознавания аудио задайте OPENAI_API_KEY в .env и перезапустите сервер");
    error.statusCode = 400;
    throw error;
  }
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_SIZE) {
    const error = new Error("Файл больше 25 МБ — ограничение OpenAI Whisper. Загрузите аудио меньшего размера");
    error.statusCode = 413;
    throw error;
  }

  const extension = path.extname(filePath).toLowerCase();
  const buffer = fs.readFileSync(filePath);
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: MIME_TYPES[extension] || "application/octet-stream" }), path.basename(filePath));
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  const whisperLanguage = LANGUAGES[String(language || "").toUpperCase()];
  if (whisperLanguage) form.append("language", whisperLanguage);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300000);
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.openaiKey}` },
      body: form,
      signal: controller.signal
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result.error?.message || `OpenAI Whisper вернул HTTP ${response.status}`);
      error.statusCode = response.status >= 400 && response.status < 500 ? 400 : 502;
      throw error;
    }

    const startedAt = Date.now();
    const transcript = transcriptFromSegments(result, startedAt);
    if (!transcript.length) {
      const error = new Error("Whisper не распознал речь в аудиофайле");
      error.statusCode = 422;
      throw error;
    }
    return transcript;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeout = new Error("Распознавание аудио не завершилось за 5 минут");
      timeout.statusCode = 504;
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { transcribeAudioFile, transcriptFromSegments };
