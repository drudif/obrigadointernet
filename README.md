# Catálogo de Referências

Um catálogo pessoal de **ferramentas, sites e recursos** — cards com descrição analítica, categorias coloridas, busca e filtros. Você adiciona referências colando uma **URL**, soltando um **print**, ou (opcionalmente) um **link de rede social** — uma **IA (Google Gemini)** lê o conteúdo, categoriza e cria o card sozinha.

Sem framework, sem build: um `index.html` estático + um servidor Node de ~1 arquivo (`server.mjs`). Roda local com duplo-clique e publica em qualquer host Node (Railway, Render, Fly, VPS…).

---

## ✨ Features

- **Cards data-driven** a partir de um único `refs-data.js` (`window.REFS_DATA`).
- **9 categorias** coloridas (IA, Design, Tipografia, Assets, Inspo, Audiovisual, Produtividade/Self-hosted, Safety, Cultura) e **3 tipos** (Site, Repo, Skill).
- **Busca** instantânea + **filtros** por categoria (clique = única; shift = somar) e por tipo.
- **Adição por IA (Gemini):**
  - **URL** → lê o site (via `url_context`) e cria o card.
  - **Imagem/print** → analisa a imagem; se o print tiver **várias** ferramentas, cria **vários** cards.
  - **Link de rede social** (opcional, requer Cobalt) → **carrossel** vira N cards (um por slide/referência) e **vídeo** tem os **frames + áudio** lidos pela IA (texto na tela + fala).
- **Dedup**: evita duplicar por URL; no ingest social a IA também deduplica por conteúdo.
- **Selinho "instalada"** para marcar itens especiais (flag `installed`).
- **Prints da home** (toggle): thumbnail do site gerada on-the-fly (mShots), sem armazenar nada.
- **Editar direto na interface**: deletar card, **arrastar** card para outra categoria/tipo (recategoriza).
- **Persistência automática** no servidor local; no deploy, edição protegida por **senha**.
- **Modo espelho read-only**: publique uma cópia pública que espelha outro deploy em tempo real, sem nenhuma opção de edição.
- **Export**: baixa o `refs-data.js` com todas as alterações aplicadas (modo arquivo).

---

## 🚀 Começando (local)

Requisitos: **Node.js 20.12+**.

```bash
npm install          # instala a única dependência (ffmpeg-static, usada só p/ vídeo)
npm start            # sobe em http://localhost:4177 e abre o navegador
```

No macOS você também pode dar **duplo-clique em `start.command`**.

Rodando local, a edição é **livre** (sem senha) e tudo que você adiciona/edita é **salvo automaticamente** no `refs-data.js`. Para adicionar por IA, configure a `GEMINI_API_KEY` (veja abaixo).

> Também dá para abrir o `index.html` direto no navegador (modo `file://`): funciona como catálogo, guarda alterações no `localStorage` e você exporta o `refs-data.js` pelo botão **Exportar**. (Nesse modo não há IA nem auto-save.)

---

## 🧠 Adicionando referências

O painel **"Adicionar referência"** aceita:

| Entrada | O que acontece | Precisa de |
|---|---|---|
| **URL** de um site/repo | Gemini lê a página e cria o card | `GEMINI_API_KEY` |
| **Imagem / print** | Gemini identifica a(s) ferramenta(s) do print | `GEMINI_API_KEY` |
| **Link social** (Instagram, TikTok, YouTube, LinkedIn…) | Carrossel → N cards; vídeo → frames+áudio lidos pela IA | `GEMINI_API_KEY` + `COBALT_API` |

A chave do Gemini fica **só no servidor** (proxy em `/api/analyze`), nunca no navegador.

---

## ⚙️ Variáveis de ambiente

Copie `.env.example` para `.env` (local) ou configure no seu host. **Todas são opcionais.**

| Variável | Para quê |
|---|---|
| `EDIT_TOKEN` | Senha de edição no **deploy**. Sem ela, o site publicado é **somente-leitura**. |
| `GEMINI_API_KEY` | Adicionar referências por URL/imagem/social. ([obter chave](https://aistudio.google.com/apikey)) |
| `COBALT_API` | Instância self-hosted do [Cobalt](https://github.com/imputnet/cobalt) para links de rede social. |
| `COBALT_KEY` | Chave da sua instância Cobalt (se exigir auth). |
| `MIRROR_URL` | Liga o **modo espelho**: serve os dados desse deploy (read-only automático). |
| `READ_ONLY` | `1` força somente-leitura sem espelhar. |
| `DEPLOY_URL` | URL do seu deploy, para o **sync** local↔deploy (botões ↑/↓). |
| `DATA_DIR` | Diretório dos dados. No deploy, aponte para um **Volume** (ex.: `/data`) para persistir. |
| `PORT` | Definido pela plataforma; local usa `4177`. |

---

## ☁️ Deploy no Railway (passo a passo)

1. Faça um **fork/clone** deste repo no seu GitHub.
2. No [Railway](https://railway.app): **New Project → Deploy from GitHub repo** e escolha o repo.
3. Em **Variables**, adicione o que for usar (no mínimo `EDIT_TOKEN` para poder editar; `GEMINI_API_KEY` para adicionar por IA).
4. (Recomendado) **Persistência**: crie um **Volume** montado em `/data` e defina `DATA_DIR=/data`. Assim o `refs-data.js` sobrevive a redeploys (o repo serve como *seed* inicial).
5. Em **Settings → Networking**, gere um **domínio público**.
6. Pronto. O site publicado é **read-only** até alguém desbloquear com a `EDIT_TOKEN`.

> **Build**: usa Nixpacks (autodetecta Node). A dependência `ffmpeg-static` traz o binário do ffmpeg (usado só no ingest de vídeo), sem configuração extra.

---

## 🪞 Modo espelho read-only (publicar uma cópia pública)

Ideal para manter **um deploy privado que você edita** e **um deploy público só de leitura** que reflete o primeiro em tempo real.

1. Suba **um segundo serviço** (mesmo repo).
2. Nele, defina **`MIRROR_URL`** = a URL do seu deploy original (ex.: `https://meu-catalogo.up.railway.app`). Não coloque `EDIT_TOKEN` nem chaves.
3. Gere um domínio público para ele.

O espelho:
- serve o `refs-data.js` do original (cache de 30s → sempre atualizado);
- **esconde** o painel de adição, o campo de senha, os botões de deletar e o arrastar;
- bloqueia todos os endpoints de escrita.

`READ_ONLY=1` (sem `MIRROR_URL`) faz o mesmo bloqueio, mas usando os dados do próprio serviço.

---

## 🎬 Cobalt (opcional — para links de rede social)

Instagram, TikTok e cia. ficam atrás de login e o `url_context` do Gemini não os lê. O [Cobalt](https://github.com/imputnet/cobalt) resolve o post e devolve a mídia; o servidor então:
- **carrossel** → manda todos os slides para a IA (um card por referência distinta);
- **vídeo** → extrai **frames** (texto na tela) + **áudio** (fala) com ffmpeg e manda para a IA. **Nada é armazenado.**

Setup rápido (Railway, rede privada — sem expor o Cobalt à internet):
1. **New Service → Docker Image**: `ghcr.io/imputnet/cobalt:11`.
2. Variables do Cobalt: `API_URL=http://cobalt.railway.internal:9000/`, `API_PORT=9000`, `API_LISTEN_ADDRESS=::`.
3. No serviço do catálogo, defina `COBALT_API=http://cobalt.railway.internal:9000`.

(Fora do Railway, aponte `COBALT_API` para qualquer instância Cobalt acessível.)

---

## 🗂️ Modelo de dados (`refs-data.js`)

```js
window.REFS_DATA = {
  scanDate: "2026-01-01",
  sources: { videos: 0, images: 0 },
  refs: [
    {
      title: "remove.bg",           // nome curto
      url: "https://remove.bg",     // link oficial ("" se não houver)
      cat: "assets",                // uma das chaves de categoria (abaixo)
      types: ["site"],              // "site" | "repo" | "skill"
      desc: "2–3 frases analíticas sobre o que é e pra que serve.",
      date: "2026-01-01",           // data de entrada
      // opcionais:
      installed: true,              // mostra o selinho "instalada"
      thumb: "https://…/preview.jpg", // miniatura fixa
      items: ["bullet 1", "bullet 2"] // vira lista no card
    }
  ]
};
```

**Categorias** (chave → rótulo, editável em `index.html`): `ai` IA/Agentes · `design` Design/UI · `type` Tipografia · `assets` Assets · `inspo` Inspo · `av` Audiovisual · `self` Produtividade/Self-hosted · `sec` Safety · `culture` Cultura.

---

## 🎨 Customizando

Tudo vive no `index.html` (CSS + JS inline, sem build):

- **Categorias**: edite o objeto `CATS` (rótulo + cor via variável CSS `--<chave>` no `:root`).
- **Tipos**: objeto `TYPES` / `TTAG`.
- **Cores e fontes**: variáveis CSS no `:root` (`--paper`, `--ink`, `--serif`, `--sans`, cores de categoria…).
- **Título/cabeçalho**: o `<h1>` no topo. (Neste repo ele é um SVG; troque pelo texto/marca que quiser.)
- **Prints da home**: o toggle usa o serviço gratuito mShots; a URL é montada em `shotUrl()`.

---

## 💾 Edição e persistência

| Contexto | Edição | Salva onde |
|---|---|---|
| `file://` (abrir o HTML) | livre | `localStorage` (+ botão **Exportar** o `refs-data.js`) |
| Servidor **local** (`npm start`) | livre | grava direto no `refs-data.js` (auto-save) |
| **Deploy** | só com `EDIT_TOKEN` | grava no `DATA_DIR`/Volume |

No local há também **sync**: **↓ Puxar do deploy** e **↑ Enviar pro deploy** (usa `DEPLOY_URL` + a senha de edição) para reconciliar os dois.

---

## 🔒 Segurança

- Chaves (`GEMINI_API_KEY`, `COBALT_KEY`) ficam **no servidor**; o cliente nunca as vê.
- `.env` e `gemini-config.js` estão no `.gitignore` — **nunca** commite segredos.
- O deploy é read-only por padrão: sem `EDIT_TOKEN`, ninguém edita.
- O ingest de vídeo **não armazena** mídia (extrai frames/áudio, analisa e descarta).

---

## 🧱 Stack

- Frontend: **HTML/CSS/JS puro** num único arquivo, data-driven.
- Backend: **Node.js** (`node:http`), sem framework. Uma dependência (`ffmpeg-static`).
- IA: **Google Gemini** (`gemini-2.5-flash`) via proxy no servidor.
- Opcional: **Cobalt** (mídia social) + **ffmpeg** (frames/áudio de vídeo).

## Licença

MIT — use, modifique e publique à vontade.
