// Серверный прокси для аудио: ссылка организаторов содержит подпись, может требовать серверный запрос
// и не отдаёт CORS/Range. Скачиваем запись один раз, кэшируем в data/audio и отдаём браузеру
// через res.sendFile — это даёт корректный Content-Type и перемотку (HTTP Range).
const fs = require("fs");
const path = require("path");

const AUDIO_DIR = path.join(__dirname, "..", "data", "audio");
const EXTS = [".mp3", ".wav", ".ogg", ".m4a", ".webm", ".flac", ".aac"];
const inflight = new Map();

const safe = id => String(id).replace(/[^a-zA-Z0-9_-]/g, "_");
function cached(id) {
  for (const e of EXTS) { const f = path.join(AUDIO_DIR, safe(id) + e); if (fs.existsSync(f)) return f; }
  return null;
}
function sniffExt(b) {
  if (b.length < 12) return null;
  const s4 = b.toString("latin1", 0, 4);
  if (s4 === "RIFF" && b.toString("latin1", 8, 12) === "WAVE") return ".wav";
  if (s4 === "OggS") return ".ogg";
  if (s4 === "fLaC") return ".flac";
  if (b.toString("latin1", 4, 8) === "ftyp") return ".m4a";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return ".webm";
  if (b.toString("latin1", 0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return ".mp3";
  return null;
}
function extFromType(ct) {
  ct = String(ct || "").toLowerCase();
  if (ct.includes("wav")) return ".wav"; if (ct.includes("ogg")) return ".ogg"; if (ct.includes("webm")) return ".webm";
  if (ct.includes("mp4") || ct.includes("m4a")) return ".m4a"; if (ct.includes("flac")) return ".flac"; if (ct.includes("aac")) return ".aac";
  if (ct.includes("mpeg") || ct.includes("mp3")) return ".mp3";
  return null;
}
// Power Automate может вернуть JSON с base64 ($content / content / body / data / audio).
function bytesFromJson(obj, depth = 0) {
  if (depth > 4 || obj == null) return null;
  if (typeof obj === "string") {
    const m = obj.match(/^data:[^;]+;base64,(.+)$/s);
    const s = (m ? m[1] : obj).replace(/\s/g, "");
    if (s.length > 2000 && /^[A-Za-z0-9+/=_-]+$/.test(s)) return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    return null;
  }
  if (typeof obj === "object") for (const v of Object.values(obj)) { const r = bytesFromJson(v, depth + 1); if (r) return r; }
  return null;
}

async function fetchFollow(url, tries = 0) {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 90000);
  try {
    const r = await fetch(url, { redirect: "follow", signal: ctl.signal, headers: { Accept: "audio/*,application/octet-stream,application/json;q=0.5,*/*;q=0.4", "User-Agent": "Mozilla/5.0 CQA" } });
    // Power Automate может ответить 202 Accepted + Location (асинхронный шаблон) — ждём результат
    if (r.status === 202 && tries < 20) {
      const next = r.headers.get("location") || url;
      await new Promise(ok => setTimeout(ok, Math.max(1, Number(r.headers.get("retry-after")) || 3) * 1000));
      return fetchFollow(next, tries + 1);
    }
    const buf = Buffer.from(await r.arrayBuffer());
    return { r, buf };
  } catch (e) { throw new Error(e.name === "AbortError" ? "Источник записи не ответил за 90 с" : "Сеть: " + e.message); }
  finally { clearTimeout(timer); }
}

async function download(id, url) {
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { r, buf: raw } = await fetchFollow(url);
      const ct = r.headers.get("content-type") || "";
      if (!r.ok) throw new Error(`Источник записи вернул HTTP ${r.status}: ${raw.toString("utf8").slice(0, 160).replace(/\s+/g, " ")}`);
      let buf = raw;
      if (/json|text|xml/i.test(ct) || buf[0] === 0x7b || buf[0] === 0x22) {
        const txt = buf.toString("utf8"); let j;
        try { j = JSON.parse(txt); } catch { j = txt; }
        if (typeof j === "string" && /^https?:\/\//.test(j)) { const n = await fetchFollow(j); buf = n.buf; }
        else if (j && typeof j === "object" && typeof (j.url || j.audio_url || j.link) === "string" && /^https?:/.test(j.url || j.audio_url || j.link)) { const n = await fetchFollow(j.url || j.audio_url || j.link); buf = n.buf; }
        else {
          const decoded = bytesFromJson(j);
          if (!decoded) throw new Error("В ответе источника нет аудио: " + txt.slice(0, 200).replace(/\s+/g, " "));
          buf = decoded;
        }
      }
      if (buf.length < 1000) throw new Error("Получен слишком короткий файл — это не аудиозапись");
      const ext = sniffExt(buf) || extFromType(ct) || ".mp3";
      const file = path.join(AUDIO_DIR, safe(id) + ext);
      fs.writeFileSync(file + ".part", buf); fs.renameSync(file + ".part", file);
      return file;
    } catch (e) { last = e.message; console.error(`[audio ${id}] попытка ${attempt + 1}: ${last}`); }
  }
  throw new Error(last);
}

async function getAudioFile(id, url) {
  const c = cached(id);
  if (c) return c;
  if (!url) throw new Error("У этого диалога нет записи");
  if (!inflight.has(id)) inflight.set(id, download(id, url).finally(() => inflight.delete(id)));
  return inflight.get(id);
}
function saveUpload(id, buf, filename) {
  for (const e of EXTS) { const f = path.join(AUDIO_DIR, safe(id) + e); if (fs.existsSync(f)) fs.unlinkSync(f); }
  const ext = sniffExt(buf) || EXTS.find(e => String(filename).toLowerCase().endsWith(e)) || ".mp3";
  fs.writeFileSync(path.join(AUDIO_DIR, safe(id) + ext), buf);
}
module.exports = { getAudioFile, saveUpload, cached };
