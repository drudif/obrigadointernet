// Servidor do catálogo REFS.
// - Serve o site e o refs-data.js (do volume, se houver: DATA_DIR).
// - POST /api/save   → grava refs-data.js (auth).
// - POST /api/analyze → proxy do Gemini (chave só no servidor; auth).
// - POST /api/auth   → valida a senha de edição.
// Auth: LOCAL (sem PORT) é confiável e livre. No deploy (PORT definido) exige
// header x-edit-token === EDIT_TOKEN. Sem EDIT_TOKEN no deploy = ninguém edita.
// Uso local: duplo-clique em start.command (ou `npm start`).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exec, spawn } from "node:child_process";
import os from "node:os";
let FFMPEG = "ffmpeg";
try { const m = await import("ffmpeg-static"); if (m.default) FFMPEG = m.default; } catch { /* usa o do PATH */ }

const DIR = path.dirname(fileURLToPath(import.meta.url));

// carrega .env local (se existir), sem depender de flag do Node (compat. c/ qualquer versão)
try {
  const envPath = path.join(DIR, ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m && process.env[m[1]] === undefined) {
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        process.env[m[1]] = v;
      }
    }
  }
} catch { /* ignore */ }

const PORT = process.env.PORT || 4177;
const HOST = process.env.PORT ? "0.0.0.0" : "127.0.0.1";
const RAILWAY = !!process.env.PORT;                       // plataforma define PORT
const DATA_DIR = process.env.DATA_DIR || DIR;             // volume persistente no deploy
const EDIT_TOKEN = process.env.EDIT_TOKEN || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const DEPLOY_URL = (process.env.DEPLOY_URL || "").replace(/\/+$/, ""); // p/ sync local↔deploy
const COBALT_API = (process.env.COBALT_API || "").replace(/\/+$/, ""); // instância self-hosted (rede privada)
const COBALT_KEY = process.env.COBALT_KEY || "";
// espelho somente-leitura: lê os dados de outro deploy (MIRROR_URL) e bloqueia toda edição.
const MIRROR_URL = (process.env.MIRROR_URL || "").replace(/\/+$/, "");
const READ_ONLY = process.env.READ_ONLY === "1" || !!MIRROR_URL;
const GMODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";     // configurável (chaves novas não acessam 2.5-flash)
const GEMINI_THINKING = process.env.GEMINI_THINKING !== "0";       // alguns modelos (flash-latest) não aceitam thinkingBudget:0
const DATA_FILE = path.join(DATA_DIR, "refs-data.js");

// seed do volume: na primeira vez copia o refs-data.js do repo para o volume
try {
  if (DATA_DIR !== DIR && !fs.existsSync(DATA_FILE) && fs.existsSync(path.join(DIR, "refs-data.js"))) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.copyFileSync(path.join(DIR, "refs-data.js"), DATA_FILE);
    console.log("volume seedado com refs-data.js do repo");
  }
} catch (e) { console.error("seed falhou:", e.message); }

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".mp4": "video/mp4", ".md": "text/markdown; charset=utf-8",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf",
};

function authed(req) {
  if (READ_ONLY) return false;            // espelho: ninguém edita, ponto
  if (!RAILWAY) return true;              // local = confiável
  if (!EDIT_TOKEN) return false;          // deploy sem senha configurada = ninguém edita
  return req.headers["x-edit-token"] === EDIT_TOKEN;
}
// cache do espelho: busca o refs-data.js do deploy original (MIRROR_URL) a cada 30s
let mirrorCache = { ts: 0, body: "" };
async function getMirrorData() {
  const now = Date.now();
  if (mirrorCache.body && now - mirrorCache.ts < 30000) return mirrorCache.body;
  try {
    const r = await fetch(MIRROR_URL + "/refs-data.js", { headers: { "cache-control": "no-store" } });
    if (r.ok) { const t = await r.text(); mirrorCache = { ts: now, body: t }; return t; }
  } catch { /* usa o cache anterior */ }
  return mirrorCache.body || "window.REFS_DATA = {scanDate:\"\",sources:{videos:0,images:0},refs:[]};\n";
}
function readBody(req, limit = 25e6) {
  return new Promise((resolve, reject) => {
    let b = ""; req.on("data", (c) => { b += c; if (b.length > limit) req.destroy(); });
    req.on("end", () => resolve(b)); req.on("error", reject);
  });
}
function json(res, code, obj) { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); }

// rate limit por IP p/ endpoints públicos (busca semântica)
const rlHits = new Map();
const semCache = new Map(); // cache de respostas da busca semântica (pergunta -> {ts, raw})
function rateOk(ip, max = 12, winMs = 5 * 60 * 1000) {
  const now = Date.now();
  const arr = (rlHits.get(ip) || []).filter((t) => now - t < winMs);
  if (arr.length >= max) { rlHits.set(ip, arr); return false; }
  arr.push(now); rlHits.set(ip, arr); return true;
}
function clientIp(req) { return String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?"; }

// ---- og-scrape: lê meta tags do post (og:image/título/descrição). Não baixa mídia. ----
function decodeEnt(s) { return (s || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/gi, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">"); }
function parseMetas(html) {
  const m = {};
  const re = /<meta[^>]+>/gi; let t;
  while ((t = re.exec(html))) {
    const tag = t[0];
    const p = (tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const c = (tag.match(/content\s*=\s*["']([^"']*)["']/i) || [])[1];
    if (p && c != null && m[p] == null) m[p] = c;
  }
  return m;
}
async function ogScrape(url) {
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; ToolsCatalog/1.0; +https://feedderefs.up.railway.app)" }, redirect: "follow" });
  const html = await r.text();
  const m = parseMetas(html);
  return {
    image: decodeEnt(m["og:image"] || m["twitter:image"] || m["twitter:image:src"] || ""),
    title: decodeEnt(m["og:title"] || m["twitter:title"] || ""),
    desc: decodeEnt(m["og:description"] || m["twitter:description"] || ""),
  };
}
// resolve um link social via Cobalt (self-hosted, rede privada). NÃO armazena nada.
async function cobalt(url, options = {}) {
  const headers = { accept: "application/json", "content-type": "application/json" };
  if (COBALT_KEY) headers.authorization = "Api-Key " + COBALT_KEY;
  const r = await fetch(COBALT_API + "/", { method: "POST", headers, body: JSON.stringify({ url, ...options }) });
  return r.json();
}
async function fetchBuf(url, cap = 20 * 1024 * 1024) {
  const r = await fetch(url); if (!r.ok) throw new Error("fetch " + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > cap) throw new Error("mídia grande demais (" + Math.round(buf.length / 1e6) + "MB)");
  return { buf, mime: (r.headers.get("content-type") || "application/octet-stream").split(";")[0] };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function run(cmd, args) { // resolve com {code, err} — quem chama decide o que fazer
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args); let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, err }));
  });
}
// vídeo → frames (texto na tela) + áudio (transcrição), via ffmpeg. Modalidades confiáveis. Nada é guardado.
async function videoParts(buf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reel-"));
  const inp = path.join(dir, "in.mp4");
  fs.writeFileSync(inp, buf);
  const parts = []; let diag = "";
  const jpgs = () => fs.readdirSync(dir).filter((f) => /\.jpg$/.test(f)).sort();
  try {
    let r = await run(FFMPEG, ["-nostdin", "-y", "-i", inp, "-vf", "fps=1,scale=720:-2", "-frames:v", "14", "-q:v", "4", path.join(dir, "f_%03d.jpg")]);
    if (!jpgs().length) { // fallback: amostra por cena/posição
      const r2 = await run(FFMPEG, ["-nostdin", "-y", "-i", inp, "-vf", "thumbnail,scale=720:-2", "-frames:v", "6", path.join(dir, "t_%03d.jpg")]);
      diag = `fps(code ${r.code}): ${r.err.slice(-160)} | thumb(code ${r2.code}): ${r2.err.slice(-160)}`;
    }
    for (const f of jpgs()) { const b = fs.readFileSync(path.join(dir, f)); parts.push({ inline_data: { mime_type: "image/jpeg", data: b.toString("base64") } }); }
    const ra = await run(FFMPEG, ["-nostdin", "-y", "-i", inp, "-vn", "-ac", "1", "-b:a", "96k", path.join(dir, "a.mp3")]);
    try { const a = fs.readFileSync(path.join(dir, "a.mp3")); if (a.length > 2000) parts.push({ inline_data: { mime_type: "audio/mp3", data: a.toString("base64") } }); } catch { void ra; }
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  const nFrames = parts.filter((p) => p.inline_data.mime_type.startsWith("image/")).length;
  console.log("videoParts: bytes=" + buf.length + " frames=" + nFrames + (diag ? " | " + diag : ""));
  if (!nFrames) throw new Error("0 frames (vídeo " + buf.length + "B) " + diag.slice(0, 200));
  return parts;
}
// sobe um arquivo (vídeo) via Files API do Gemini e espera ficar ACTIVE. Retorna file_uri.
async function geminiUpload(buf, mime, displayName = "media") {
  const base = "https://generativelanguage.googleapis.com";
  const start = await fetch(`${base}/upload/v1beta/files?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
    method: "POST",
    headers: { "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start", "X-Goog-Upload-Header-Content-Length": String(buf.length), "X-Goog-Upload-Header-Content-Type": mime, "content-type": "application/json" },
    body: JSON.stringify({ file: { display_name: displayName } }),
  });
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) { const t = await start.text().catch(() => ""); throw new Error("start " + start.status + " " + t.slice(0, 140)); }
  const up = await fetch(uploadUrl, { method: "POST", headers: { "Content-Length": String(buf.length), "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" }, body: buf });
  const upText = await up.text();
  let info; try { info = JSON.parse(upText); } catch { throw new Error("finalize não-JSON " + up.status + " " + upText.slice(0, 140)); }
  if (!info.file) throw new Error("finalize " + up.status + " " + JSON.stringify(info).slice(0, 140));
  let { name, state, uri } = info.file;
  for (let i = 0; i < 40 && state === "PROCESSING"; i++) {
    await sleep(1500);
    const st = await (await fetch(`${base}/v1beta/${name}?key=${encodeURIComponent(GEMINI_API_KEY)}`)).json();
    state = st.state; uri = st.uri || uri;
  }
  if (state !== "ACTIVE") throw new Error("estado " + (state || "?"));
  return uri;
}
// uma chamada multimodal ao Gemini que devolve {cards:[...]}. Thinking desligado + retry em erro transitório.
async function geminiCards(parts) {
  const gc = { temperature: 0.3, maxOutputTokens: 8192, responseMimeType: "application/json" };
  if (GEMINI_THINKING) gc.thinkingConfig = { thinkingBudget: 0 };   // só onde o modelo aceita
  const body = { contents: [{ parts }], generationConfig: gc };
  const TRANSIENT = new Set([429, 500, 502, 503, 504]);
  let lastErr = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await sleep(1500 * attempt); // 1.5s, 3s, 4.5s, 6s
    let gr, gj;
    try {
      gr = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GMODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      gj = await gr.json().catch(() => ({}));
    } catch (e) { lastErr = "rede: " + e.message; continue; }
    if (gj.error) {
      const code = Number(gj.error.code || gr.status);
      lastErr = "Gemini " + code + ": " + String(gj.error.message || "").slice(0, 200);
      if (TRANSIENT.has(code)) continue;        // sobrecarga/cota → tenta de novo
      throw new Error(lastErr);                 // erro permanente → aborta
    }
    const cand = (gj.candidates || [])[0];
    const text = (((cand || {}).content || {}).parts || []).map((p) => p.text).filter(Boolean).join("");
    if (text) return text;
    lastErr = "Gemini retornou vazio" + (cand && cand.finishReason ? " (finishReason: " + cand.finishReason + ")" : " (sem candidato)");
  }
  throw new Error(lastErr + " — tente novamente em instantes");
}

function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/" || p === "") p = "/index.html";
  const fp = p === "/refs-data.js" ? DATA_FILE : path.join(DIR, p); // dados vêm do volume
  if (!fp.startsWith(DIR) && fp !== DATA_FILE) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (e, d) => {
    if (e) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": TYPES[path.extname(fp).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" });
    res.end(d);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    // espelho: serve os dados do deploy original (sempre sincronizado)
    if (MIRROR_URL && (req.url === "/refs-data.js" || req.url.startsWith("/refs-data.js?"))) {
      const body = await getMirrorData();
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      return res.end(body);
    }
    if (req.method === "GET" && req.url === "/api/health") {
      return json(res, 200, { ok: true, railway: RAILWAY, hasEditToken: !!EDIT_TOKEN, hasGeminiKey: !!GEMINI_API_KEY, usingVolume: DATA_DIR !== DIR, dataDir: DATA_DIR, hasCobalt: !!COBALT_API, readOnly: READ_ONLY, mirror: !!MIRROR_URL, semantic: (!!GEMINI_API_KEY || !!MIRROR_URL) && !READ_ONLY });
    }
    if (req.method === "POST" && req.url === "/api/auth") {
      const { token } = JSON.parse((await readBody(req)) || "{}");
      return json(res, 200, { ok: !RAILWAY || (!!EDIT_TOKEN && token === EDIT_TOKEN) });
    }
    if (req.method === "POST" && req.url === "/api/save") {
      if (!authed(req)) return json(res, 401, { ok: false, error: "não autorizado" });
      const data = JSON.parse((await readBody(req)) || "{}");
      if (!data || !Array.isArray(data.refs)) return json(res, 400, { ok: false, error: "payload inválido" });
      const js = "/* Atualizado automaticamente pelo catálogo (server.mjs). */\nwindow.REFS_DATA = " + JSON.stringify(data, null, 2) + ";\n";
      const tmp = path.join(DATA_DIR, ".refs-data.tmp.js");
      fs.writeFileSync(tmp, js); fs.renameSync(tmp, DATA_FILE);
      console.log(new Date().toLocaleTimeString(), "salvo — " + data.refs.length + " refs");
      return json(res, 200, { ok: true, count: data.refs.length });
    }
    if (req.method === "POST" && req.url === "/api/analyze") {
      if (!authed(req)) return json(res, 401, { ok: false, error: "não autorizado" });
      if (!GEMINI_API_KEY) return json(res, 500, { ok: false, error: "GEMINI_API_KEY não configurada no servidor" });
      const body = (await readBody(req)) || "{}";
      const TRANSIENT = new Set([429, 500, 502, 503, 504]);
      let gres, text = "";
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) await sleep(1500 * attempt); // 1.5s, 3s, 4.5s
        gres = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GMODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
          { method: "POST", headers: { "content-type": "application/json" }, body });
        text = await gres.text();
        if (!TRANSIENT.has(gres.status)) break; // erro transitório → tenta de novo
      }
      res.writeHead(gres.status, { "content-type": "application/json" });
      return res.end(text);
    }
    // ---- fallback: servidor busca a página (UA de navegador), extrai texto/meta e o Gemini estrutura ----
    if (req.method === "POST" && req.url === "/api/readurl") {
      if (!authed(req)) return json(res, 401, { ok: false, error: "não autorizado" });
      if (!GEMINI_API_KEY) return json(res, 500, { ok: false, error: "GEMINI_API_KEY não configurada" });
      const { url, prompt } = JSON.parse((await readBody(req)) || "{}");
      if (!url) return json(res, 400, { ok: false, error: "url ausente" });
      let html = "";
      try {
        const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", "accept": "text/html,*/*", "accept-language": "pt-BR,pt,en" }, redirect: "follow" });
        html = await r.text();
      } catch (e) { return json(res, 502, { ok: false, error: "não consegui abrir o site: " + e.message }); }
      const m = parseMetas(html);
      const title = decodeEnt(m["og:title"] || m["twitter:title"] || (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
      const mdesc = decodeEnt(m["og:description"] || m["twitter:description"] || m["description"] || "");
      const textBody = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim().slice(0, 3500);
      if (!title && !mdesc && textBody.length < 40) return json(res, 422, { ok: false, error: "site sem conteúdo legível (pode exigir login ou bloquear robôs)" });
      const ctx = `\n\nConteúdo do site (URL oficial: ${url}):\nTítulo: ${title}\nDescrição: ${mdesc}\nTexto: ${textBody}\n\nUse a URL oficial acima como "url".`;
      const raw = await geminiCards([{ text: (prompt || "Produza {title,url,cat,types,desc}.") + ctx }]);
      if (!raw) return json(res, 502, { ok: false, error: "Gemini não respondeu" });
      return json(res, 200, { ok: true, raw });
    }
    // ---- busca semântica PÚBLICA (sem senha): prompt montado no servidor, rate-limit por IP ----
    if (req.method === "POST" && req.url === "/api/semantic") {
      if (READ_ONLY) return json(res, 403, { ok: false, error: "busca semântica indisponível neste site" }); // fora do espelho
      const ip = clientIp(req);
      if (!rateOk(ip)) return json(res, 429, { ok: false, error: "muitas buscas — aguarde um pouco" });
      let body; try { body = JSON.parse((await readBody(req)) || "{}"); } catch { body = {}; }
      const q = String(body.q || "").slice(0, 300).trim();
      if (!q) return json(res, 400, { ok: false, error: "pergunta vazia" });
      // sem chave local mas com espelho → encaminha pro original (a chave fica num lugar só)
      if (!GEMINI_API_KEY && MIRROR_URL) {
        try {
          const r = await fetch(MIRROR_URL + "/api/semantic", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ q }) });
          const t = await r.text(); res.writeHead(r.status, { "content-type": "application/json" }); return res.end(t);
        } catch { return json(res, 502, { ok: false, error: "upstream indisponível" }); }
      }
      if (!GEMINI_API_KEY) return json(res, 400, { ok: false, error: "busca semântica indisponível" });
      let catText = "", nRefs = 0;
      try {
        const src = MIRROR_URL ? await getMirrorData() : fs.readFileSync(DATA_FILE, "utf8");
        const w = {}; new Function("window", src)(w);
        const refs = (w.REFS_DATA && w.REFS_DATA.refs) || [];
        nRefs = refs.length;
        catText = refs.map((r) => `"${String(r.title || "").replace(/"/g, "'")}" [${r.cat}${(r.types || []).length ? "/" + r.types.join(",") : ""}] ${String(r.desc || "").slice(0, 220)}${r.url ? " (" + r.url + ")" : ""}`).join("\n");
      } catch { return json(res, 500, { ok: false, error: "catálogo indisponível" }); }
      // cache: pergunta normalizada + tamanho do catálogo (muda se cards forem add/removidos). TTL 6h.
      const ckey = q.toLowerCase().replace(/\s+/g, " ").trim() + "|" + nRefs;
      const hit = semCache.get(ckey);
      if (hit && Date.now() - hit.ts < 6 * 3600 * 1000) return json(res, 200, { ok: true, raw: hit.raw, cached: true });
      const prompt = `Você é um assistente de busca semântica de um catálogo de ferramentas, sites e recursos, em PORTUGUÊS. Responda à pergunta de forma útil e direta (2 a 5 frases), recomendando os itens mais adequados pelo NOME, com base APENAS no catálogo abaixo. Depois liste os títulos EXATOS dos itens relevantes, do mais para o menos relevante (máx. 12). Se nada servir, diga isso e devolva matches vazio.\n\nCATÁLOGO:\n${catText}\n\nPERGUNTA: ${q}\n\nResponda SOMENTE em JSON: {"answer":"...","matches":["título exato",...]}`;
      let raw; try { raw = await geminiCards([{ text: prompt }]); } catch (e) { return json(res, 502, { ok: false, error: e.message }); }
      semCache.set(ckey, { ts: Date.now(), raw });
      if (semCache.size > 500) semCache.delete(semCache.keys().next().value); // limita o cache
      return json(res, 200, { ok: true, raw });
    }
    // ---- ingerir link social via Cobalt: carrossel (todos os slides) ou vídeo (áudio→transcrição).
    //      NÃO armazena mídia. O Gemini devolve {cards:[...]} já filtrado e sem duplicatas. ----
    if (req.method === "POST" && req.url === "/api/ingest") {
      if (!authed(req)) return json(res, 401, { ok: false, error: "não autorizado" });
      if (!GEMINI_API_KEY) return json(res, 500, { ok: false, error: "GEMINI_API_KEY não configurada" });
      if (!COBALT_API) return json(res, 400, { ok: false, error: "COBALT_API não configurada (Cobalt fora do ar)" });
      const { url, prompt } = JSON.parse((await readBody(req)) || "{}");
      if (!url) return json(res, 400, { ok: false, error: "url ausente" });

      // 1) resolve o link no Cobalt
      let cj; try { cj = await cobalt(url); } catch (e) { return json(res, 502, { ok: false, error: "cobalt inacessível: " + e.message }); }

      // 2) monta as partes multimodais + descreve o modo
      const parts = []; let kind = "image", note = "";
      try {
        if (cj.status === "picker" && Array.isArray(cj.picker)) {
          const photos = cj.picker.filter((p) => p.type === "photo" && p.url).slice(0, 20);
          if (!photos.length) return json(res, 422, { ok: false, error: "carrossel sem imagens legíveis" });
          kind = "carousel";
          for (const p of photos) { const { buf, mime } = await fetchBuf(p.url, 8 * 1024 * 1024); parts.push({ inline_data: { mime_type: mime.startsWith("image/") ? mime : "image/jpeg", data: buf.toString("base64") } }); }
          parts.push({ text: `${prompt}\n\n== ENTRADA: ${photos.length} SLIDES de um carrossel (na ordem). ==` });
        } else if (cj.status === "tunnel" || cj.status === "redirect" || (cj.status === "picker" && cj.picker.some((p) => p.type === "video"))) {
          // vídeo → frames (texto na tela) + áudio (fala) via ffmpeg. 480p p/ baixar leve. Nada é guardado.
          kind = "video";
          let vurl = "";
          try { const vj = await cobalt(url, { videoQuality: "480" }); vurl = (vj.status === "tunnel" || vj.status === "redirect") ? vj.url : ((vj.picker || []).find((p) => p.type === "video") || {}).url || ""; } catch { /* usa o cj abaixo */ }
          if (!vurl) vurl = (cj.status === "tunnel" || cj.status === "redirect") ? cj.url : ((cj.picker || []).find((p) => p.type === "video") || {}).url || "";
          if (!vurl) return json(res, 502, { ok: false, error: "não consegui obter o vídeo (" + (cj.error?.code || cj.status || "?") + ")" });
          let vid; try { vid = await fetchBuf(vurl, 120 * 1024 * 1024); } catch (e) { return json(res, 413, { ok: false, error: "vídeo " + e.message }); }
          console.log("ingest video:", url, "| cobalt=" + cj.status, "| vurl=" + (vurl ? "sim" : "não"), "| bytes=" + vid.buf.length, "| mime=" + vid.mime);
          let media; try { media = await videoParts(vid.buf); } catch (e) { return json(res, 502, { ok: false, error: "processamento do vídeo (ffmpeg): " + e.message }); }
          if (!media.length) return json(res, 502, { ok: false, error: "não consegui extrair frames do vídeo" });
          for (const m of media) parts.push(m);
          const og = await ogScrape(url).catch(() => ({}));
          const cap = [og.title && "Legenda/título: " + og.title, og.desc && "Descrição do post: " + og.desc].filter(Boolean).join("\n");
          parts.push({ text: `${prompt}\n\n== ENTRADA: FRAMES (imagens em ordem cronológica) de um VÍDEO curto + o ÁUDIO dele. Leia o TEXTO QUE APARECE NA TELA (overlays, nomes de sites/ferramentas/URLs exibidos) e TAMBÉM ouça a fala. Capte TODOS os sites, ferramentas e recursos citados ou mostrados — muitos aparecem só como texto na tela.${cap ? "\n\n" + cap : ""} ==` });
        } else {
          return json(res, 422, { ok: false, error: "cobalt não resolveu o link (" + (cj.error?.code || cj.status || "?") + ")" });
        }
      } catch (e) { return json(res, 502, { ok: false, error: "falha ao baixar mídia do cobalt: " + e.message }); }

      // 3) uma chamada ao Gemini → {cards:[...]}
      let raw; try { raw = await geminiCards(parts); } catch (e) { return json(res, 502, { ok: false, error: e.message }); }
      return json(res, 200, { ok: true, kind, raw, source: url });
    }
    // ---- sync local ↔ deploy (só no local) ----
    if (req.method === "POST" && (req.url === "/api/pull" || req.url === "/api/push")) {
      if (RAILWAY) return json(res, 403, { ok: false, error: "sync só funciona no servidor local" });
      if (!DEPLOY_URL) return json(res, 400, { ok: false, error: "DEPLOY_URL não configurada no .env" });
      if (req.url === "/api/pull") {
        const r = await fetch(DEPLOY_URL + "/refs-data.js", { headers: { "cache-control": "no-store" } });
        if (!r.ok) return json(res, 502, { ok: false, error: "deploy respondeu HTTP " + r.status });
        const txt = await r.text();
        const w = {}; new Function("window", txt)(w);
        if (!w.REFS_DATA || !Array.isArray(w.REFS_DATA.refs)) return json(res, 502, { ok: false, error: "refs-data.js inválido no deploy" });
        const tmp = path.join(DATA_DIR, ".refs-data.tmp.js"); fs.writeFileSync(tmp, txt); fs.renameSync(tmp, DATA_FILE);
        return json(res, 200, { ok: true, count: w.REFS_DATA.refs.length });
      } else { // push
        const token = (JSON.parse((await readBody(req)) || "{}").token) || EDIT_TOKEN;
        if (!token) return json(res, 400, { ok: false, error: "informe a senha de edição do deploy" });
        const local = fs.readFileSync(DATA_FILE, "utf8");
        const w = {}; new Function("window", local)(w);
        const r = await fetch(DEPLOY_URL + "/api/save", { method: "POST", headers: { "content-type": "application/json", "x-edit-token": token }, body: JSON.stringify(w.REFS_DATA) });
        const rt = await r.text();
        res.writeHead(r.status, { "content-type": "application/json" }); return res.end(rt);
      }
    }
    serveStatic(req, res);
  } catch (err) {
    json(res, 500, { ok: false, error: String(err && err.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  if (RAILWAY) {
    console.log("REFS catalog (deploy) na porta " + PORT + (MIRROR_URL ? " — ESPELHO read-only de " + MIRROR_URL : READ_ONLY ? " — somente leitura" : EDIT_TOKEN ? " — edição com senha" : " — somente leitura (sem EDIT_TOKEN)"));
  } else {
    const url = "http://localhost:" + PORT;
    console.log("REFS catalog em " + url + " — edição livre, refs-data.js auto-salvo. (Ctrl+C encerra.)");
    exec('open "' + url + '"');
  }
});
