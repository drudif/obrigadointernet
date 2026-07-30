// Catálogo de Referências — servidor Node stdlib (sem framework, sem build).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, exec } from "node:child_process";
import os from "node:os";

let FFMPEG = "ffmpeg";
try {
  const mod = await import("ffmpeg-static");
  if (mod?.default) FFMPEG = mod.default;
} catch {}

const DIR = path.dirname(fileURLToPath(import.meta.url));

// --- .env loader (manual, sem dependência) ---
(function loadEnv() {
  const envPath = path.join(DIR, ".env");
  if (!fs.existsSync(envPath)) return;
  const src = fs.readFileSync(envPath, "utf8");
  for (const line of src.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
})();

// --- config ---
const PORT = process.env.PORT || 4177;
const RAILWAY = !!process.env.PORT;
const HOST = process.env.PORT ? "0.0.0.0" : "127.0.0.1";
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : DIR;
const EDIT_TOKEN = process.env.EDIT_TOKEN || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const DEPLOY_URL = (process.env.DEPLOY_URL || "").replace(/\/$/, "");
const COBALT_API = (process.env.COBALT_API || "").replace(/\/$/, "");
const COBALT_KEY = process.env.COBALT_KEY || "";
const MIRROR_URL = (process.env.MIRROR_URL || "").replace(/\/$/, "");
const READ_ONLY = process.env.READ_ONLY === "1" || !!MIRROR_URL;
const GMODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_THINKING = process.env.GEMINI_THINKING !== "0";
const DATA_FILE = path.join(DATA_DIR, "refs-data.js");

// --- volume seed (primeiro boot) ---
if (DATA_DIR !== DIR) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const repoSeed = path.join(DIR, "refs-data.js");
    if (!fs.existsSync(DATA_FILE) && fs.existsSync(repoSeed)) {
      fs.copyFileSync(repoSeed, DATA_FILE);
    }
  } catch (e) {
    console.error("[seed] falhou:", e.message);
  }
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") p = "/index.html";
  let fp, root;
  if (p === "/refs-data.js") {
    fp = DATA_FILE;
    root = path.normalize(DATA_DIR);
  } else {
    fp = path.join(DIR, p);
    root = path.normalize(DIR);
  }
  const resolved = path.normalize(fp);
  if (!resolved.startsWith(root)) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  fs.readFile(resolved, (err, buf) => {
    if (err) {
      res.writeHead(404);
      return res.end("not found");
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      "content-type": TYPES[ext] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(buf);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

// --- auth: pivô local (sem senha) vs deploy (x-edit-token) vs espelho (nunca) ---
function authed(req) {
  if (READ_ONLY) return false;
  if (!RAILWAY) return true;
  if (!EDIT_TOKEN) return false;
  return req.headers["x-edit-token"] === EDIT_TOKEN;
}

function readBody(req, limit = 25e6) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        req.socket.destroy();
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function saveRefsData(data) {
  const text = `/* Dados do catálogo. Editado pelo servidor (auto-save) ou manualmente. */\nwindow.REFS_DATA = ${JSON.stringify(data, null, 2)};\n`;
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, DATA_FILE);
}

// --- rate limit + cache da busca semântica (em memória, sem persistência) ---
const rlHits = new Map();
function clientIp(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
}
function rateOk(ip, max = 12, winMs = 5 * 60 * 1000) {
  const now = Date.now();
  const hits = (rlHits.get(ip) || []).filter((t) => now - t < winMs);
  if (hits.length >= max) {
    rlHits.set(ip, hits);
    return false;
  }
  hits.push(now);
  rlHits.set(ip, hits);
  return true;
}
const semCache = new Map();
const SEM_TTL = 6 * 60 * 60 * 1000;
const SEM_CAP = 500;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function decodeEnt(s) {
  return (s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function parseMetas(html) {
  const metas = {};
  const re = /<meta\s+[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const prop = tag.match(/(?:property|name)=["']([^"']+)["']/i)?.[1];
    const content = tag.match(/content=["']([^"']*)["']/i)?.[1];
    if (prop && content !== undefined && !(prop in metas)) metas[prop] = decodeEnt(content);
  }
  return {
    title: metas["og:title"] || metas["twitter:title"] || "",
    desc: metas["og:description"] || metas["twitter:description"] || metas["description"] || "",
    image: metas["og:image"] || metas["twitter:image"] || "",
  };
}

async function ogScrape(url) {
  const r = await fetch(url, { headers: { "user-agent": UA } });
  if (!r.ok) throw new Error(`fetch falhou: ${r.status}`);
  const html = await r.text();
  const meta = parseMetas(html);
  const titleTag = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
  if (!meta.title && titleTag) meta.title = decodeEnt(titleTag.trim());
  return meta;
}

async function cobalt(url, options = {}) {
  const r = await fetch(COBALT_API + "/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(COBALT_KEY ? { authorization: `Api-Key ${COBALT_KEY}` } : {}),
    },
    body: JSON.stringify({ url, ...options }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.code || `cobalt http ${r.status}`);
  return j;
}

async function fetchBuf(url, cap = 20e6) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch falhou: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > cap) throw new Error(`arquivo maior que o limite (${cap} bytes)`);
  return { buf, mime: r.headers.get("content-type") || "" };
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => resolve({ code: -1, err: e.message }));
    p.on("close", (code) => resolve({ code, err }));
  });
}

// --- pipeline de vídeo: extrai frames+áudio via ffmpeg, monta parts pro Gemini ---
async function videoParts(buf) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refs-video-"));
  try {
    const src = path.join(tmp, "in.mp4");
    fs.writeFileSync(src, buf);

    const framesDir = path.join(tmp, "frames");
    fs.mkdirSync(framesDir);
    await run(FFMPEG, ["-i", src, "-vf", "fps=1,scale=720:-2", "-frames:v", "14", path.join(framesDir, "f%02d.jpg")]);
    let frameFiles = fs.readdirSync(framesDir).filter((f) => f.endsWith(".jpg")).sort();

    if (frameFiles.length === 0) {
      // fallback: 6 frames por scene-sample (thumbnails)
      await run(FFMPEG, ["-i", src, "-vf", "select='gt(scene,0.1)',scale=720:-2", "-frames:v", "6", "-vsync", "vfr", path.join(framesDir, "s%02d.jpg")]);
      frameFiles = fs.readdirSync(framesDir).filter((f) => f.endsWith(".jpg")).sort();
    }
    if (frameFiles.length === 0) throw new Error("não consegui extrair frames do vídeo");

    const parts = frameFiles.map((f) => ({
      inline_data: { mime_type: "image/jpeg", data: fs.readFileSync(path.join(framesDir, f)).toString("base64") },
    }));

    const audioPath = path.join(tmp, "a.mp3");
    await run(FFMPEG, ["-i", src, "-vn", "-ac", "1", "-b:a", "96k", audioPath]);
    if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 2000) {
      parts.push({ inline_data: { mime_type: "audio/mp3", data: fs.readFileSync(audioPath).toString("base64") } });
    }

    return parts;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const TRANSIENT = new Set([429, 500, 502, 503, 504]);
const BACKOFF = [1500, 3000, 4500, 6000];
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- chamada compartilhada ao Gemini (generateContent), sem SDK ---
async function geminiCards(parts) {
  const body = {
    contents: [{ parts }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
      ...(GEMINI_THINKING ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GMODEL}:generateContent?key=${GEMINI_API_KEY}`;
  let lastErr;
  for (let attempt = 0; attempt <= BACKOFF.length; attempt++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        if (TRANSIENT.has(r.status) && attempt < BACKOFF.length) {
          await sleep(BACKOFF[attempt]);
          continue;
        }
        throw new Error(`gemini http ${r.status}: ${await r.text()}`);
      }
      const j = await r.json();
      const cand = j.candidates?.[0];
      const text = (cand?.content?.parts || []).map((p) => p.text || "").join("");
      if (!text) throw new Error(`gemini vazio (finishReason=${cand?.finishReason || "?"})`);
      return text;
    } catch (e) {
      lastErr = e;
      if (attempt < BACKOFF.length && !/gemini http/.test(e.message)) {
        await sleep(BACKOFF[attempt]);
        continue;
      }
      if (/gemini http/.test(e.message)) throw e;
    }
  }
  throw lastErr;
}

// --- modo espelho: reflete refs-data.js de outro deploy, TTL 30s ---
let mirrorCache = { text: "", at: 0 };
async function getMirrorData() {
  if (Date.now() - mirrorCache.at < 30000 && mirrorCache.text) return mirrorCache.text;
  const r = await fetch(MIRROR_URL + "/refs-data.js");
  if (!r.ok) throw new Error("mirror fetch failed: " + r.status);
  const text = await r.text();
  mirrorCache = { text, at: Date.now() };
  return text;
}

export { videoParts, fetchBuf };

const server = http.createServer((req, res) => {
  (async () => {
    try {
      const u = new URL(req.url, "http://x");

      if (MIRROR_URL && u.pathname === "/refs-data.js") {
        const text = await getMirrorData();
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        return res.end(text);
      }

      if (req.method === "GET" && u.pathname === "/api/health") {
        return json(res, 200, {
          ok: true,
          railway: RAILWAY,
          hasEditToken: !!EDIT_TOKEN,
          hasGeminiKey: !!GEMINI_API_KEY,
          usingVolume: DATA_DIR !== DIR,
          dataDir: DATA_DIR,
          hasCobalt: !!COBALT_API,
          readOnly: READ_ONLY,
          mirror: !!MIRROR_URL,
          semantic: !!GEMINI_API_KEY || !!MIRROR_URL,
        });
      }

      if (req.method === "POST" && u.pathname === "/api/auth") {
        const body = await readBody(req);
        const ok = !RAILWAY || (!!EDIT_TOKEN && body.token === EDIT_TOKEN);
        return json(res, 200, { ok });
      }

      if (req.method === "POST" && u.pathname === "/api/save") {
        if (!authed(req)) return json(res, 401, { ok: false, error: "não autenticado" });
        const data = await readBody(req);
        if (!Array.isArray(data.refs)) return json(res, 400, { ok: false, error: "refs deve ser um array" });
        saveRefsData(data);
        return json(res, 200, { ok: true, count: data.refs.length });
      }

      if (req.method === "POST" && u.pathname === "/api/analyze") {
        if (!authed(req)) return json(res, 401, { ok: false, error: "não autenticado" });
        if (!GEMINI_API_KEY) return json(res, 400, { ok: false, error: "GEMINI_API_KEY não configurada" });
        const body = await readBody(req);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${GMODEL}:generateContent?key=${GEMINI_API_KEY}`;
        for (let attempt = 0; attempt < 4; attempt++) {
          const r = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          if (r.ok || !TRANSIENT.has(r.status) || attempt === 3) {
            const text = await r.text();
            res.writeHead(r.status, { "content-type": "application/json; charset=utf-8" });
            return res.end(text);
          }
          await sleep(BACKOFF[attempt]);
        }
      }

      if (req.method === "POST" && u.pathname === "/api/readurl") {
        if (!authed(req)) return json(res, 401, { ok: false, error: "não autenticado" });
        if (!GEMINI_API_KEY) return json(res, 400, { ok: false, error: "GEMINI_API_KEY não configurada" });
        const { url: pageUrl, prompt } = await readBody(req);
        let html;
        try {
          const r = await fetch(pageUrl, { headers: { "user-agent": UA } });
          if (!r.ok) throw new Error(`http ${r.status}`);
          html = await r.text();
        } catch (e) {
          return json(res, 502, { ok: false, error: "não consegui buscar a URL: " + e.message });
        }
        const meta = parseMetas(html);
        const stripped = html
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        const body = decodeEnt(stripped).slice(0, 3500);
        if (!meta.title && !meta.desc && body.length < 200) {
          return json(res, 422, { ok: false, error: "conteúdo insuficiente (página bloqueada/exige login?)" });
        }
        const ctx = `\n\nTítulo: ${meta.title}\nDescrição: ${meta.desc}\nConteúdo: ${body}`;
        try {
          const raw = await geminiCards([{ text: (prompt || "") + ctx }]);
          return json(res, 200, { ok: true, raw });
        } catch (e) {
          return json(res, 500, { ok: false, error: e.message });
        }
      }

      if (req.method === "POST" && u.pathname === "/api/semantic") {
        const ip = clientIp(req);
        if (!rateOk(ip)) return json(res, 429, { ok: false, error: "muitas perguntas, espere um pouco" });
        const { q } = await readBody(req);
        const query = String(q || "").slice(0, 300).trim();
        if (!query) return json(res, 400, { ok: false, error: "pergunta vazia" });

        if (!GEMINI_API_KEY && MIRROR_URL) {
          const r = await fetch(MIRROR_URL + "/api/semantic", {
            method: "POST",
            headers: { "content-type": "application/json", "x-forwarded-for": ip },
            body: JSON.stringify({ q: query }),
          });
          const text = await r.text();
          res.writeHead(r.status, { "content-type": "application/json; charset=utf-8" });
          return res.end(text);
        }
        if (!GEMINI_API_KEY) return json(res, 400, { ok: false, error: "busca semântica indisponível" });

        let src;
        if (MIRROR_URL) src = await getMirrorData();
        else src = fs.readFileSync(DATA_FILE, "utf8");
        const w = {};
        new Function("window", src)(w);
        const refs = w.REFS_DATA?.refs || [];

        const ckey = query.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "") + "|" + refs.length;
        const cached = semCache.get(ckey);
        if (cached && Date.now() - cached.at < SEM_TTL) return json(res, 200, { ok: true, raw: cached.raw });

        const catalog = refs
          .map((r) => `- ${r.title} [${[r.cat, ...(r.cat2 ? [r.cat2] : [])].join(",")}/${(r.types || []).join(",")}] ${(r.desc || "").slice(0, 220)} (${r.url || ""})`)
          .join("\n");
        const prompt = `Você é o assistente de busca de um catálogo pessoal de referências. Responda a pergunta do usuário SOMENTE com base no catálogo abaixo, em 2 a 5 frases, em português. Depois liste os títulos exatos dos itens do catálogo que respondem à pergunta.\n\nCatálogo:\n${catalog}\n\nPergunta: ${query}\n\nResponda em JSON: {"answer": "...", "matches": ["título exato 1", "título exato 2"]}`;

        try {
          const raw = await geminiCards([{ text: prompt }]);
          if (semCache.size >= SEM_CAP) semCache.delete(semCache.keys().next().value);
          semCache.set(ckey, { raw, at: Date.now() });
          return json(res, 200, { ok: true, raw });
        } catch (e) {
          return json(res, 500, { ok: false, error: e.message });
        }
      }

      if (req.method === "POST" && u.pathname === "/api/ingest") {
        if (!authed(req)) return json(res, 401, { ok: false, error: "não autenticado" });
        if (!GEMINI_API_KEY) return json(res, 400, { ok: false, error: "GEMINI_API_KEY não configurada" });
        if (!COBALT_API) return json(res, 400, { ok: false, error: "COBALT_API não configurada" });
        const { url: srcUrl, prompt } = await readBody(req);

        let cj;
        try {
          cj = await cobalt(srcUrl);
        } catch (e) {
          return json(res, 502, { ok: false, error: "cobalt falhou: " + e.message });
        }

        const pickerVideo = cj.status === "picker" && (cj.picker || []).some((it) => it.type === "video");
        const pickerPhotos = cj.status === "picker" ? (cj.picker || []).filter((it) => it.type === "photo") : [];

        let parts = [];
        let kind;

        if (cj.status === "picker" && pickerPhotos.length && !pickerVideo) {
          kind = "carousel";
          const photos = pickerPhotos.slice(0, 20);
          if (!photos.length) return json(res, 422, { ok: false, error: "cobalt não retornou fotos" });
          for (const item of photos) {
            try {
              const { buf, mime } = await fetchBuf(item.url, 8e6);
              parts.push({ inline_data: { mime_type: mime || "image/jpeg", data: buf.toString("base64") } });
            } catch {}
          }
          if (!parts.length) return json(res, 422, { ok: false, error: "não consegui baixar as fotos do carrossel" });
          parts.push({ text: `Isto é um carrossel de ${parts.length} slides (nesta ordem). Considere cada slide que mostrar uma referência distinta.` });
        } else if (cj.status === "tunnel" || cj.status === "redirect" || pickerVideo) {
          kind = "video";
          let videoUrl = cj.url;
          try {
            const cj2 = await cobalt(srcUrl, { videoQuality: "480" });
            if (cj2.url) videoUrl = cj2.url;
            else if (pickerVideo) videoUrl = (cj2.picker || cj.picker).find((it) => it.type === "video")?.url || videoUrl;
          } catch {}
          if (!videoUrl) return json(res, 502, { ok: false, error: "cobalt não retornou URL de vídeo" });
          let buf;
          try {
            ({ buf } = await fetchBuf(videoUrl, 120e6));
          } catch (e) {
            return json(res, 413, { ok: false, error: "download do vídeo falhou: " + e.message });
          }
          try {
            parts = await videoParts(buf);
          } catch (e) {
            return json(res, 502, { ok: false, error: e.message });
          }
          try {
            const meta = await ogScrape(srcUrl);
            if (meta.title || meta.desc) parts.push({ text: `Legenda/contexto do post: ${meta.title} ${meta.desc}` });
          } catch {}
        } else {
          return json(res, 422, { ok: false, error: "cobalt não resolveu o link" });
        }

        parts.push({ text: prompt || "" });
        try {
          const raw = await geminiCards(parts);
          return json(res, 200, { ok: true, kind, raw, source: srcUrl });
        } catch (e) {
          return json(res, 500, { ok: false, error: e.message });
        }
      }

      if (req.method === "POST" && u.pathname === "/api/pull") {
        if (RAILWAY) return json(res, 403, { ok: false, error: "só disponível localmente" });
        if (!DEPLOY_URL) return json(res, 400, { ok: false, error: "DEPLOY_URL não configurada" });
        const r = await fetch(DEPLOY_URL + "/refs-data.js");
        if (!r.ok) return json(res, 502, { ok: false, error: "falha ao buscar o deploy: " + r.status });
        const text = await r.text();
        const w = {};
        try {
          new Function("window", text)(w);
          if (!Array.isArray(w.REFS_DATA?.refs)) throw new Error("shape inválido");
        } catch (e) {
          return json(res, 502, { ok: false, error: "dado do deploy inválido: " + e.message });
        }
        const tmp = DATA_FILE + ".tmp";
        fs.writeFileSync(tmp, text);
        fs.renameSync(tmp, DATA_FILE);
        return json(res, 200, { ok: true, count: w.REFS_DATA.refs.length });
      }

      if (req.method === "POST" && u.pathname === "/api/push") {
        if (RAILWAY) return json(res, 403, { ok: false, error: "só disponível localmente" });
        if (!DEPLOY_URL) return json(res, 400, { ok: false, error: "DEPLOY_URL não configurada" });
        const body = await readBody(req);
        const token = body.token || EDIT_TOKEN;
        const localText = fs.readFileSync(DATA_FILE, "utf8");
        const w = {};
        new Function("window", localText)(w);
        const r = await fetch(DEPLOY_URL + "/api/save", {
          method: "POST",
          headers: { "content-type": "application/json", "x-edit-token": token },
          body: JSON.stringify(w.REFS_DATA),
        });
        const text = await r.text();
        res.writeHead(r.status, { "content-type": "application/json; charset=utf-8" });
        return res.end(text);
      }

      return serveStatic(req, res);
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
  })();
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`;
  if (MIRROR_URL) {
    console.log(`[espelho] ${url} — refletindo ${MIRROR_URL}`);
  } else if (READ_ONLY) {
    console.log(`[somente-leitura] ${url}`);
  } else if (RAILWAY) {
    console.log(`[deploy] ${url} — edição ${EDIT_TOKEN ? "protegida por senha" : "desligada (sem EDIT_TOKEN)"}`);
  } else {
    console.log(`[local] ${url} — edição livre`);
    exec(`open ${url}`, () => {});
  }
});
