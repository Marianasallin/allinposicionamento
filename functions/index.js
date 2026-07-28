// ════════════════════════════════════════════════════════════════
// ALL IN TEMA — cofre (backend) da IA  ·  versão GATILHO DE BANCO
// O site grava o pedido em /_ai/req/{id}. Esta função é acionada
// pelo próprio banco (não é pública — contorna a política da org),
// chama o Claude e grava a resposta em /_ai/res/{id}.
// A chave da IA fica só aqui (Secret Manager), nunca no site.
// ════════════════════════════════════════════════════════════════
const { onValueCreated } = require("firebase-functions/v2/database");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
admin.initializeApp();

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const MODEL = "claude-opus-4-8";

function systemPrompt() {
  return [
    "Você é ALL IN TEMA, a IA de conteúdo da agência ALL IN, especialista em LinkedIn.",
    "Seu trabalho é criar temas e legendas de alto engajamento e autoridade para os clientes da agência.",
    "",
    "Regras invioláveis:",
    "- Escreva em português brasileiro impecável, com acentuação e concordância corretas.",
    "- Sempre respeite a LINHA EDITORIAL do cliente (tom, temas, público e o que evitar) quando fornecida.",
    "- Tom HUMANO, próximo e específico do nicho — nada de clichê ou cara de texto gerado por IA.",
    "- Legendas com gancho forte na 1ª linha, texto escaneável e 1 CTA claro.",
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
  let ctx = "DADOS DO CLIENTE\n";
  if (nome) ctx += "Cliente: " + nome + "\n";
  if (nicho) ctx += "Nicho: " + nicho + "\n";
  ctx += "Rede: LinkedIn\n";
  if (formato) ctx += "Formato do post: " + formato + " (adeque a estrutura a esse formato)\n";
  ctx += "\nLINHA EDITORIAL DO CLIENTE:\n" + (linha || "(não informada — use o nicho e bom senso, e mantenha tom profissional)") + "\n";
  if (hist.length) ctx += "\nTEMAS/POSTS JÁ FEITOS (não repita):\n- " + hist.join("\n- ") + "\n";
  if (obs) ctx += "\n⚠️ OBSERVAÇÃO/PEDIDO DA EQUIPE (prioridade máxima — siga à risca):\n" + obs + "\n";
  if (body.mode === "legenda") {
    const tema = (body.theme || "").trim();
    return ctx + "\nTAREFA: escreva UMA legenda completa e pronta para revisão para o tema abaixo, seguindo a linha editorial.\n" +
      "Tema: " + (tema || "(defina você um bom tema alinhado ao cliente)") + "\n" +
      "Estrutura: gancho na 1ª linha, corpo escaneável, 1 CTA e no máximo 5 hashtags em CamelCase. Responda só com a legenda.";
  }
  return ctx + "\nTAREFA: sugira 5 TEMAS de post ATUAIS e alinhados a este cliente.\n" +
    "Para cada tema: um título curto e forte + 1 linha explicando o ângulo. Numere de 1 a 5. Não escreva a legenda ainda.";
}

exports.allintema = onValueCreated(
  {
    ref: "/_ai/req/{reqId}",
    instance: "allin-sistema-default-rtdb",
    secrets: [ANTHROPIC_API_KEY],
    region: "us-central1",
    timeoutSeconds: 120,
    memory: "256MiB",
  },
  async (event) => {
    const reqId = event.params.reqId;
    const body = (event.data && event.data.val()) || {};
    const resRef = admin.database().ref("/_ai/res/" + reqId);
    try {
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
