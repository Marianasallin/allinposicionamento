// ════════════════════════════════════════════════════════════════
// ALL IN TEMA — cofre (backend) da IA  ·  versão GATILHO DE BANCO
// O site grava o pedido em /_ai/req/{id}. Esta função é acionada
// pelo próprio banco (não é pública — contorna a política da org),
// chama o Claude e grava a resposta em /_ai/res/{id}.
// A chave da IA fica só aqui (Secret Manager), nunca no site.
// ════════════════════════════════════════════════════════════════
const { onValueCreated } = require("firebase-functions/v2/database");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
admin.initializeApp();

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const DRIVE_API_KEY = defineSecret("DRIVE_API_KEY");
const MODEL = "claude-opus-4-8";
const IMG_MODEL = "gemini-2.5-flash-image";

// Monta o prompt da arte a partir do tema + linha editorial + formato + observações
function buildArtPrompt(body) {
  const tema = (body.theme || "").trim();
  const linha = (body.editorialLine || "").trim();
  const formato = (body.formato || "").trim();
  const obs = (body.obs || "").trim();
  const comTexto = body.comTexto !== false; // por padrão, escreve texto na arte
  const textoArte = (body.textoArte || tema || "").trim();
  const ehCarrossel = /carrossel/i.test(formato);
  const temModelo = !!(body.refModelo || body.refEdit);

  let p = "Crie uma arte PROFISSIONAL para post de rede social (serve para LinkedIn e para o feed do Instagram). ";
  p += "FORMATO OBRIGATÓRIO: imagem QUADRADA, proporção 1:1, alta resolução, composição pensada para feed (nada cortado nas bordas).\n";
  if (tema) p += "Tema do post: " + tema + ".\n";
  if (ehCarrossel) p += (body.slide ? "Esta é uma PÁGINA (slide) de um carrossel." : "Esta é a CAPA de um carrossel — deve ser chamativa e convidar a arrastar.") + "\n";
  if (body.semFoto) p += "NÃO inclua pessoas, rostos nem retratos. Gere apenas um FUNDO/cenário limpo e elegante (ambiente, textura ou gradiente) nas cores da marca, com bastante espaço de respiro.\n";
  if (comTexto && textoArte) {
    p += "ESCREVA na arte, como título/chamada em destaque, EXATAMENTE este texto e NADA MAIS, mantendo a grafia e a acentuação corretas do português brasileiro, SEM erros e SEM cortar palavras: \"" + textoArte + "\". ";
    p += "REGRA ABSOLUTA: a ÚNICA palavra ou frase escrita na imagem deve ser exatamente esse texto. É PROIBIDO adicionar qualquer outro texto — nada de subtítulos, chamadas como 'deslize', 'arraste', 'saiba mais', números de página, marca d'água, assinatura ou legenda. Sem texto em outro idioma. O texto deve ficar bem legível, com boa hierarquia e integrado ao design.\n";
  } else {
    p += "REGRA CRÍTICA E ABSOLUTA: NÃO escreva NENHUM texto, palavra, letra, número, título, data, subtítulo, assinatura, marca d'água nem legenda em lugar NENHUM da imagem. ZERO caracteres. ";
    p += "Gere APENAS o fundo visual (foto, cores, texturas e elementos gráficos). NÃO desenhe caixas, retângulos, balões ou molduras destinados a receber texto — o texto e as caixas serão adicionados por cima depois pelo sistema. ";
    p += "Deixe áreas limpas e uniformes com espaço de respiro para o texto ser colocado depois.\n";
  }
  if (linha) p += "Identidade e linha editorial do cliente (siga estilo, cores e tom): " + linha + ".\n";
  if (temModelo) {
    p += "MUITO IMPORTANTE: siga FIELMENTE o ESTILO VISUAL da imagem de referência — mesma PALETA DE CORES, mesmo clima e mesmo nível de acabamento profissional. ";
    if (!comTexto) p += "ATENÇÃO: a imagem de referência PODE CONTER TEXTOS e CAIXAS de texto — IGNORE-OS COMPLETAMENTE. NÃO copie, NÃO reproduza e NÃO reescreva nenhum texto, número ou caixa de texto da referência. Copie apenas cores, iluminação e estilo visual, deixando a arte SEM qualquer texto.";
    p += "\n";
  }
  if (obs) p += "Instruções específicas (siga à risca): " + obs + ".\n";
  p += "Arte limpa, moderna e profissional, sem marcas d'água, sem logos de terceiros e sem texto embaralhado.";
  return p;
}

// Converte links de "visualização" (Drive/Dropbox) para o arquivo direto da imagem
function normalizeImageUrl(url) {
  url = (url || "").trim();
  if (!url) return url;
  // Google Drive → endpoint de thumbnail (devolve a imagem de forma confiável, se o arquivo estiver público)
  let m = url.match(/drive\.google\.com\/file\/d\/([^/]+)/) ||
          url.match(/drive\.google\.com\/(?:open|uc)\?(?:[^#]*&)?id=([^&]+)/) ||
          url.match(/[?&]id=([-\w]{20,})/);
  if (m) return "https://drive.google.com/thumbnail?id=" + m[1] + "&sz=w2000";
  // Dropbox → arquivo bruto
  if (/dropbox\.com/.test(url)) return url.replace(/[?&]dl=\d/, "").replace(/[?&]raw=\d/, "") + (url.indexOf("?") >= 0 ? "&raw=1" : "?raw=1");
  return url;
}

// Detecta link de PASTA do Google Drive
function driveFolderId(url) {
  const m = (url || "").match(/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([-\w]+)/) ||
            (url || "").match(/[?&]folderview[^]*?[?&]id=([-\w]+)/) ||
            (url || "").match(/folders\/([-\w]{20,})/);
  return m ? m[1] : null;
}
// Lista as imagens de uma pasta pública do Drive (ordenadas por nome)
async function listFolderImages(folderId) {
  const q = "'" + folderId + "' in parents and mimeType contains 'image/' and trashed=false";
  const u = "https://www.googleapis.com/drive/v3/files?q=" + encodeURIComponent(q) +
    "&key=" + DRIVE_API_KEY.value() + "&fields=files(id,name)&pageSize=100&orderBy=name&supportsAllDrives=true&includeItemsFromAllDrives=true";
  const r = await fetch(u);
  const j = await r.json();
  if (j.error) throw new Error("drive: " + (j.error.message || "erro ao listar pasta"));
  return (j.files || []);
}
// Resolve uma referência para uma URL direta de imagem (pasta do Drive → escolhe uma imagem)
async function resolveRefUrl(rawUrl, role) {
  const fid = driveFolderId(rawUrl || "");
  if (fid) {
    const imgs = await listFolderImages(fid);
    if (!imgs.length) throw new Error("pasta sem imagens");
    // foto do cliente: varia (aleatória) entre posts; modelo de estilo: sempre a 1ª (consistência)
    const pick = role === "foto" ? imgs[Math.floor(Math.random() * imgs.length)] : imgs[0];
    return "https://drive.google.com/thumbnail?id=" + pick.id + "&sz=w2000";
  }
  return normalizeImageUrl(rawUrl);
}

// Baixa uma referência (já resolvida) e valida que é imagem de verdade (pelos primeiros bytes)
async function fetchRefImage(url) {
  const ir = await fetch(url, { redirect: "follow" });
  const ab = await ir.arrayBuffer();
  const b = Buffer.from(ab);
  let mime = (ir.headers.get("content-type") || "").split(";")[0].trim();
  // detecta pelo cabeçalho binário (assinatura mágica), independente do content-type
  if (b.length > 12) {
    if (b[0] === 0xFF && b[1] === 0xD8) mime = "image/jpeg";
    else if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) mime = "image/png";
    else if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) mime = "image/gif";
    else if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) mime = "image/webp";
  }
  if (mime.indexOf("image/") !== 0) throw new Error("não é imagem");
  return { mime, data: b.toString("base64") };
}

// Gera a arte no Gemini, faz upload no Storage e devolve a URL
async function generateArt(body, reqId) {
  const parts = [{ text: buildArtPrompt(body) }];
  // referências rotuladas. No modo overlay (texto pelo sistema) NÃO enviamos o modelo,
  // porque a IA acaba copiando texto/caixas/logo dele; o design é feito pelo sistema.
  const usarModelo = !!body.comTexto;
  const usarFoto = !body.semFoto;
  const refSpecs = [
    { url: usarModelo ? body.refModelo : "", role: "modelo", label: "IMAGEM DE REFERÊNCIA DE ESTILO — copie fielmente desta arte a TIPOGRAFIA (fontes), a PALETA DE CORES, o layout e o nível de acabamento profissional. A arte final deve parecer da mesma linha visual desta referência:" },
    { url: usarFoto ? body.refFoto : "", role: "foto", label: "FOTO DO CLIENTE — use esta pessoa/imagem na arte, mantendo o rosto e a aparência:" },
    { url: body.refEdit, role: "edit", label: "Esta é a arte ATUAL. Faça a alteração pedida mantendo o resto igual:" },
  ];
  let refsReq = 0, refsOk = 0, refsFail = [];
  for (const spec of refSpecs) {
    if (!spec.url) continue;
    refsReq++;
    try {
      const resolved = await resolveRefUrl(spec.url, spec.role);
      const img = await fetchRefImage(resolved);
      parts.push({ text: spec.label });
      parts.push({ inline_data: { mime_type: img.mime, data: img.data } });
      refsOk++;
    } catch (e) { refsFail.push(spec.url); }
  }
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + IMG_MODEL + ":generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY.value() },
    body: JSON.stringify({ contents: [{ parts }] }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "Erro na IA de imagem");
  const outParts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  const imgPart = outParts.find((p) => p.inlineData || p.inline_data);
  if (!imgPart) throw new Error("A IA não retornou imagem. " + outParts.map((p) => p.text).filter(Boolean).join(" ").slice(0, 140));
  const d = imgPart.inlineData || imgPart.inline_data;
  const buf = Buffer.from(d.data, "base64");
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const path = "artes/" + reqId + ".png";
  const bucket = admin.storage().bucket("allin-sistema-artes");
  await bucket.file(path).save(buf, { contentType: "image/png", metadata: { metadata: { firebaseStorageDownloadTokens: token } } });
  const imageUrl = "https://firebasestorage.googleapis.com/v0/b/" + bucket.name + "/o/" + encodeURIComponent(path) + "?alt=media&token=" + token;
  return { imageUrl, custoBRL: Number((0.039 * 5.5).toFixed(3)), refsReq, refsOk, refsFail };
}

// Usa um MODELO/TEMPLATE do cliente como fundo — SEM chamar a IA (custo zero).
// Resolve o link (Drive/pasta), baixa a imagem e sobe pro Storage (com CORS) pra o canvas usar.
async function useTemplate(body, reqId) {
  const raw = body.templateUrl || body.refModelo || body.refFoto;
  if (!raw) throw new Error("Nenhum modelo/template informado.");
  let img;
  try {
    const resolved = await resolveRefUrl(raw, "modelo");
    img = await fetchRefImage(resolved);
  } catch (e) { throw new Error("Não consegui abrir o modelo. Deixe o arquivo/pasta público no Drive."); }
  const buf = Buffer.from(img.data, "base64");
  const ext = img.mime === "image/png" ? "png" : "jpg";
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const path = "artes/tpl" + reqId + "." + ext;
  const bucket = admin.storage().bucket("allin-sistema-artes");
  await bucket.file(path).save(buf, { contentType: img.mime, metadata: { metadata: { firebaseStorageDownloadTokens: token } } });
  const imageUrl = "https://firebasestorage.googleapis.com/v0/b/" + bucket.name + "/o/" + encodeURIComponent(path) + "?alt=media&token=" + token;
  return { imageUrl, custoBRL: 0 };
}

// Recebe uma imagem em base64 e sobe pro Storage (admin, sem depender de regras). Custo zero.
async function uploadImage(body, reqId) {
  const b64 = (body.data || "").replace(/^data:[^;]+;base64,/, "");
  if (!b64) throw new Error("Sem imagem para subir.");
  const buf = Buffer.from(b64, "base64");
  if (!buf.length || buf.length > 20 * 1024 * 1024) throw new Error("Arquivo inválido ou grande demais.");
  const mime = (body.mime || "image/png").split(";")[0];
  const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const path = "artes/up" + reqId + "." + ext;
  const bucket = admin.storage().bucket("allin-sistema-artes");
  await bucket.file(path).save(buf, { contentType: mime, metadata: { metadata: { firebaseStorageDownloadTokens: token } } });
  const imageUrl = "https://firebasestorage.googleapis.com/v0/b/" + bucket.name + "/o/" + encodeURIComponent(path) + "?alt=media&token=" + token;
  return { imageUrl };
}

function systemPrompt() {
  return [
    "Você é ALL IN TEMA, a IA de conteúdo da agência ALL IN, especialista em LinkedIn.",
    "Seu trabalho é criar temas e legendas de alto engajamento e autoridade para os clientes da agência.",
    "",
    "Regras invioláveis:",
    "- Escreva em português brasileiro impecável. Revise a pontuação e redobre a atenção com concordância verbal e nominal (ex: '68% da equipe apontam', 'é um argumento').",
    "- Sempre respeite a LINHA EDITORIAL do cliente (tom, temas, público e o que evitar) quando fornecida.",
    "- Traga sempre TEMAS ATUAIS, conectados ao nicho do cliente e ao momento (tendências, pautas em alta, sazonalidade do período informado). Evite temas genéricos e atemporais.",
    "- Tom HUMANO, próximo e específico do nicho. Nada de clichê ou cara de texto gerado por IA.",
    "- Escreva de forma FLUIDA e CONVERSACIONAL, como uma conversa contínua com o leitor. Conecte as ideias com naturalidade.",
    "- EVITE o estilo picotado: nada de dezenas de frases soltas de uma linha só. Prefira parágrafos curtos de 2 a 4 frases que fluem entre si. 'Escaneável' NÃO é 'picotado'.",
    "- NÃO use travessão (—) nem hífen como pausa no meio da frase (isso denuncia texto de IA). Use vírgula, ponto ou dois-pontos. No máximo uma listinha curta (com → ou •) na legenda inteira.",
    "- Gancho forte na 1ª linha e 1 CTA claro no fim.",
    "- NO MÁXIMO 5 hashtags, sempre em CamelCase (ex: #PlanejamentoFinanceiro). NUNCA use underscore.",
    "- Você SUGERE; a equipe da ALL IN sempre revisa e ajusta antes de publicar.",
  ].join("\n");
}

function buildUserMessage(body) {
  const nome = (body.clientName || "").trim();
  const nicho = (body.niche || "").trim();
  const linha = (body.editorialLine || "").trim();
  const formato = (body.formato || "").trim();
  const obs = (body.obs || "").trim();
  const hist = Array.isArray(body.history) ? body.history.filter(Boolean).slice(0, 20) : [];
  const meses = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
  const agora = new Date();
  const hoje = meses[agora.getMonth()] + " de " + agora.getFullYear();
  let ctx = "DADOS DO CLIENTE\n";
  if (nome) ctx += "Cliente: " + nome + "\n";
  if (nicho) ctx += "Nicho: " + nicho + "\n";
  ctx += "Rede: LinkedIn\n";
  ctx += "Momento atual: estamos em " + hoje + " (traga temas atuais e sazonais coerentes com este período).\n";
  if (formato) ctx += "Formato do post: " + formato + "\n";
  ctx += "\nLINHA EDITORIAL DO CLIENTE:\n" + (linha || "(não informada — use o nicho e bom senso, e mantenha tom profissional)") + "\n";
  if (hist.length) ctx += "\nTEMAS/POSTS JÁ FEITOS (não repita):\n- " + hist.join("\n- ") + "\n";
  if (obs) ctx += "\n⚠️ OBSERVAÇÃO/PEDIDO DA EQUIPE (prioridade máxima, siga à risca):\n" + obs + "\n";
  if (body.mode === "legenda") {
    const tema = (body.theme || "").trim();
    const base = ctx + "\nTAREFA: crie o conteúdo para o tema abaixo, seguindo a linha editorial.\n" +
      "Tema: " + (tema || "(defina você um bom tema alinhado ao cliente)") + "\n\n";
    if (formato === "Carrossel") {
      return base + "Formato CARROSSEL. Responda EXATAMENTE neste formato:\n\nLEGENDA:\n<a legenda do post: gancho na 1ª linha, corpo fluido e 1 CTA, com no máximo 5 hashtags em CamelCase no fim>\n\nSLIDES:\n<liste NO MÁXIMO 5 slides, um por linha, assim: 'Slide 1: título curto do slide — microtexto de apoio'. Use no máximo 5 slides para facilitar a criação da arte.>";
    }
    if (formato === "Enquete") {
      return base + "Formato ENQUETE do LinkedIn. Responda EXATAMENTE neste formato:\n\nLEGENDA:\n<texto curto que contextualiza a enquete, com no máximo 5 hashtags em CamelCase>\n\nPERGUNTA:\n<a pergunta da enquete>\n\nOPÇÕES (no máximo 4, e cada uma com NO MÁXIMO 30 caracteres — limite do LinkedIn):\n- <opção 1>\n- <opção 2>\n- <opção 3>\n- <opção 4>";
    }
    return base + "Escreva UMA legenda completa: gancho na 1ª linha, corpo fluido e escaneável, 1 CTA e no máximo 5 hashtags em CamelCase. Responda só com a legenda.";
  }
  return ctx + "\nTAREFA: sugira 5 TEMAS de post ATUAIS (conectados a tendências e pautas do momento) e alinhados ao nicho deste cliente.\n" +
    "Para cada tema: um título curto e forte + 1 linha explicando o ângulo. Numere de 1 a 5. Não escreva a legenda ainda.";
}

exports.allintema = onValueCreated(
  {
    ref: "/_ai/req/{reqId}",
    instance: "allin-sistema-default-rtdb",
    secrets: [ANTHROPIC_API_KEY, GEMINI_API_KEY, DRIVE_API_KEY],
    region: "us-central1",
    timeoutSeconds: 120,
    memory: "512MiB",
  },
  async (event) => {
    const reqId = event.params.reqId;
    const body = (event.data && event.data.val()) || {};
    const resRef = admin.database().ref("/_ai/res/" + reqId);
    try {
      if (body.mode === "upload") {
        const out = await uploadImage(body, reqId);
        await resRef.set({ imageUrl: out.imageUrl, mode: "upload", custoBRL: 0, ts: Date.now() });
        await event.data.ref.remove();
        return;
      }
      if (body.mode === "template") {
        const out = await useTemplate(body, reqId);
        await resRef.set({ imageUrl: out.imageUrl, mode: "template", custoBRL: 0, ts: Date.now() });
        await event.data.ref.remove();
        return;
      }
      if (body.mode === "arte") {
        const out = await generateArt(body, reqId);
        await resRef.set({ imageUrl: out.imageUrl, mode: "arte", custoBRL: out.custoBRL, refsReq: out.refsReq || 0, refsOk: out.refsOk || 0, ts: Date.now() });
        await event.data.ref.remove();
        return;
      }
      const mode = body.mode === "legenda" ? "legenda" : "temas";
      const maxTokens = mode === "legenda" ? 1200 : 900;
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY.value(),
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: maxTokens,
          system: systemPrompt(),
          messages: [{ role: "user", content: buildUserMessage(Object.assign({}, body, { mode })) }],
        }),
      });
      const j = await r.json();
      if (j.error) {
        await resRef.set({ error: j.error.message || "Erro na IA", at: Date.now() });
      } else {
        const text = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
        const u = j.usage || {};
        const custoBRL = Number((((u.input_tokens || 0) * 5 / 1e6 + (u.output_tokens || 0) * 25 / 1e6) * 5.5).toFixed(3));
        await resRef.set({ text, mode, custoBRL, at: Date.now() });
      }
    } catch (e) {
      await resRef.set({ error: String((e && e.message) || e), at: Date.now() });
    }
    try { await admin.database().ref("/_ai/req/" + reqId).remove(); } catch (_) {}
  }
);

// ════════════════════════════════════════════════════════════════
// SINCRONIZAÇÃO AUTOMÁTICA DA AGENDA (Implementação Comercial)
// Roda sozinha de tempos em tempos. Lê a agenda da responsável via
// conta de serviço com DELEGAÇÃO DE DOMÍNIO do Workspace (sem login
// de ninguém), filtra pela etiqueta (cor), casa com o cliente pelo
// e-mail e grava/atualiza os encontros em allin/clients/<i>/encounters.
// Controle (liga/desliga, e-mail) fica em /agendaSync, fora de /allin.
// ════════════════════════════════════════════════════════════════
const GCAL_DEFAULT_SUBJECT = "nayara@agenciaallin.com";
const GCAL_SA_EMAIL = "agenda-sync@allin-sistema.iam.gserviceaccount.com";

// Token do próprio SA da função (servidor de metadados) — sem chave baixada
async function _runtimeToken() {
  const r = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", { headers: { "Metadata-Flavor": "Google" } });
  const j = await r.json();
  if (!j.access_token) throw new Error("metadata token falhou");
  return j.access_token;
}
// Access token da agenda via delegação de domínio SEM chave: assina o JWT pela
// IAM Credentials API (signJwt) e troca por token imitando o dono da agenda.
async function gcalAccessToken(subject) {
  const now = Math.floor(Date.now() / 1000);
  const claim = { iss: GCAL_SA_EMAIL, sub: subject, scope: "https://www.googleapis.com/auth/calendar.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 };
  const admTok = await _runtimeToken();
  const sr = await fetch("https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/" + encodeURIComponent(GCAL_SA_EMAIL) + ":signJwt", {
    method: "POST",
    headers: { Authorization: "Bearer " + admTok, "Content-Type": "application/json" },
    body: JSON.stringify({ payload: JSON.stringify(claim) }),
  });
  const sj = await sr.json();
  if (sj.error) throw new Error("signJwt: " + (sj.error.message || JSON.stringify(sj.error)));
  const tr = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=" + sj.signedJwt,
  });
  const tj = await tr.json();
  if (tj.error) throw new Error("token: " + (tj.error_description || tj.error));
  return tj.access_token;
}
// Classifica anexos pós-reunião em gravação (vídeo) e transcrição/anotações (doc)
function gcalLinksFromEvent(e) {
  let rec = "", tr = "";
  (e.attachments || []).forEach((a) => {
    const mt = ("" + (a.mimeType || "")).toLowerCase();
    const t = ("" + (a.title || "")).toLowerCase();
    const u = a.fileUrl || "";
    if (!rec && (mt.indexOf("video") >= 0 || /grava|record/.test(t))) rec = u;
    if (!tr && (mt.indexOf("document") >= 0 || /transcri|anota|\bnotes?\b|resumo/.test(t))) tr = u;
  });
  return { rec, tr };
}
function gcalYMD(d) {
  const p = (n) => (n < 10 ? "0" : "") + n;
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

async function runAgendaSync() {
  const db = admin.database();
  // Controle (liga/desliga + e-mail) — fora de /allin pra não brigar com o app
  const ctrlSnap = await db.ref("agendaSync").get();
  const ctrl = ctrlSnap.val() || {};
  if (!ctrl.enabled) return { skipped: "desligado (agendaSync/enabled != true)" };
  const subject = (ctrl.email || GCAL_DEFAULT_SUBJECT).trim();
  // Cor da etiqueta — de agendaSync/colorId (override) ou da config que o app salva (allin/gcalCfg)
  const cfgSnap = await db.ref("allin/gcalCfg").get();
  const colorId = (ctrl.colorId || (cfgSnap.val() && cfgSnap.val().colorId) || "").toString();
  if (!colorId) {
    const msg = { skipped: "etiqueta (cor) de IC nao configurada - faca 1 importacao manual escolhendo a cor, ou defina agendaSync/colorId", at: Date.now() };
    await db.ref("agendaSync/lastRun").set(msg).catch(() => {});
    return msg;
  }
  const token = await gcalAccessToken(subject);
  // Eventos: 90 dias atrás até 31 dias à frente
  const now = new Date();
  const timeMin = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 90).toISOString();
  const timeMax = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 31, 23, 59, 59).toISOString();
  const url = "https://www.googleapis.com/calendar/v3/calendars/" + encodeURIComponent(subject) +
    "/events?singleEvents=true&orderBy=startTime&maxResults=250&timeMin=" + encodeURIComponent(timeMin) + "&timeMax=" + encodeURIComponent(timeMax);
  const r = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  const ej = await r.json();
  if (ej.error) throw new Error("agenda: " + (ej.error.message || "erro ao ler"));
  let events = (ej.items || []).filter((e) => e && e.start && (e.start.dateTime || e.start.date) && e.status !== "cancelled");
  if (colorId) events = events.filter((e) => (e.colorId || "") === colorId);

  // Clientes de IC + mapa de e-mail → chave do cliente em allin/clients
  const clientsSnap = await db.ref("allin/clients").get();
  const clientsRaw = clientsSnap.val() || {};
  const keys = Array.isArray(clientsRaw) ? clientsRaw.map((_, i) => String(i)) : Object.keys(clientsRaw);
  const emailToKey = {};
  keys.forEach((k) => {
    const c = clientsRaw[k];
    if (!c) return;
    if (!(c.products || []).includes("Implementação Comercial")) return; // só IC
    const es = [];
    if (c.email) es.push(c.email);
    if (Array.isArray(c.portalEmails)) c.portalEmails.forEach((x) => { if (x) es.push(x); });
    es.forEach((e) => { const kk = ("" + e).trim().toLowerCase(); if (kk) emailToKey[kk] = k; });
  });

  let nNew = 0, nUpd = 0;
  for (const e of events) {
    // acha o cliente pelo e-mail de algum convidado
    let key = null;
    for (const a of (e.attendees || [])) {
      const em = ("" + (a.email || "")).trim().toLowerCase();
      if (em && emailToKey[em]) { key = emailToKey[em]; break; }
    }
    if (key == null) continue;
    const lk = gcalLinksFromEvent(e);
    const start = e.start.dateTime || e.start.date;
    const d = new Date(start);
    const date = e.start.dateTime ? gcalYMD(d) : e.start.date;
    const time = e.start.dateTime ? (("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2)) : "";
    const atts = (e.attendees || []).map((a) => a.displayName || a.email).filter(Boolean);
    // transação na lista de encontros do cliente: dedupe por gcalId; novo ou completa links
    const encRef = db.ref("allin/clients/" + key + "/encounters");
    const res = await encRef.transaction((cur) => {
      cur = cur || {};
      let list = Array.isArray(cur.list) ? cur.list.slice() : (cur.list && typeof cur.list === "object" ? Object.values(cur.list) : []);
      const existing = list.find((x) => x && x.gcalId === e.id);
      if (existing) {
        let upd = false;
        if (lk.rec && !existing.recordingLink) { existing.recordingLink = lk.rec; upd = true; }
        if (lk.tr && !existing.transcriptionLink) { existing.transcriptionLink = lk.tr; upd = true; }
        if (!upd) return; // nada muda → aborta a transação
        cur.__op = "upd";
      } else {
        list.push({ date, time, tipo: "IC", description: e.summary || "Encontro", attendees: atts, notes: (e.hangoutLink ? "Link da reunião: " + e.hangoutLink : ""), transcriptionLink: lk.tr || "", recordingLink: lk.rec || "", attachments: [], gcalId: e.id, gcalColorId: e.colorId || "" });
        cur.__op = "new";
      }
      cur.list = list;
      return cur;
    });
    if (res.committed && res.snapshot && res.snapshot.child("__op").exists()) {
      const op = res.snapshot.child("__op").val();
      if (op === "new") nNew++; else if (op === "upd") nUpd++;
      await encRef.child("__op").remove().catch(() => {});
    }
  }
  if (nNew || nUpd) { try { await db.ref("allin/_rev").set(Date.now()); } catch (_) {} }
  const summary = { ok: true, novos: nNew, atualizados: nUpd, eventos: events.length, at: Date.now() };
  await db.ref("agendaSync/lastRun").set(summary).catch(() => {});
  return summary;
}

exports.syncAgendaIC = onSchedule(
  { schedule: "every 2 hours", serviceAccount: GCAL_SA_EMAIL, region: "us-central1", timeoutSeconds: 120, memory: "256MiB" },
  async () => {
    try {
      const out = await runAgendaSync();
      console.log("syncAgendaIC:", JSON.stringify(out));
    } catch (e) {
      console.error("syncAgendaIC erro:", (e && e.message) || e);
      try { await admin.database().ref("agendaSync/lastRun").set({ error: String((e && e.message) || e), at: Date.now() }); } catch (_) {}
    }
  }
);
