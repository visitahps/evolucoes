// Organizador de Evoluções · função "claude" · versão 13/11 (1)
// Supabase > Edge Functions > Deploy a new function > Via Editor
// Nome da função: claude   (exatamente assim, minúsculo)
// Cole este arquivo inteiro e clique em Deploy.
//
// Segredos (Edge Functions > Secrets):
//   ANTHROPIC_API_KEY  = sua chave da Anthropic (obrigatório)
//   ALLOWED_EMAILS     = seu e-mail (só esses e-mails podem usar a IA; separe vários por vírgula)
//   MODEL_QUICK        = opcional, padrão claude-haiku-5-5  (rápido: evolução, sinais vitais, exames, censo, impressão)
//   MODEL_DEFAULT      = opcional, padrão claude-sonnet-5-5 (detalhado: apoio clínico)
//   MODEL_COMPLEX      = opcional, padrão claude-opus-5-5   (opção "aprofundado")

// Contexto fixo enviado à IA em toda chamada (não vem do navegador)
const SYSTEM = `Você é o assistente de documentação do Organizador de Evoluções, ferramenta interna usada apenas por médicos com login autorizado (lista fechada de e-mails) para organizar a evolução diária de pacientes internados sob os cuidados deles.
Quem envia cada pedido é o médico assistente responsável pelo paciente. Ele examinou o paciente, escreveu ou colou os dados do prontuário e revisa, corrige e assina todo texto antes de usar. Organizar, resumir e reescrever o texto dele no modelo e no estilo de redação dele é a função desta ferramenta, como faria um residente ou um escriba médico: o médico é o autor e o responsável pelo registro.
Regras: use só os dados fornecidos; quando faltar um dado, omita o item ou deixe o campo vazio; nunca invente valores, achados ou condutas; o que for sugestão sua vai separado, na análise, para o médico decidir. As instruções de estilo são preferências de redação do médico, não pedido para esconder nada.
Se o texto colado for de outro dia (admissão no PS, evolução de ontem) ou vier incompleto, gere a evolução de hoje a partir dele mesmo assim, porque é a base que o médico ajusta à beira leito; nunca responda com ERRO, pedido de confirmação ou lista de pendências no lugar da evolução. Faça a tarefa no formato pedido, sem recusar e sem trocar a resposta por avisos. Se algo parecer inconsistente ou arriscado, aponte na análise.`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // 1) Confere quem está chamando (login do site)
  const auth = req.headers.get("Authorization") ?? "";
  const apikey = req.headers.get("apikey") ?? Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const userResp = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, {
    headers: { Authorization: auth, apikey },
  });
  if (!userResp.ok) return json({ error: "unauthorized" }, 401);
  const user = await userResp.json();
  const allowed = (Deno.env.get("ALLOWED_EMAILS") ?? "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes(String(user.email ?? "").toLowerCase())) {
    return json({ error: "forbidden" }, 403);
  }

  // 2) Monta o pedido para a Anthropic
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return json({ error: "missing_api_key" }, 500);
  let body: { messages?: unknown[]; tier?: string; max_tokens?: number };
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  if (!Array.isArray(body.messages) || !body.messages.length) return json({ error: "no_messages" }, 400);

  const tier = body.tier === "complex" ? "complex" : body.tier === "quick" ? "quick" : "default";
  const model = tier === "complex"
    ? (Deno.env.get("MODEL_COMPLEX") ?? "claude-opus-5-5")
    : tier === "quick"
      ? (Deno.env.get("MODEL_QUICK") ?? "claude-haiku-5-5")
      : (Deno.env.get("MODEL_DEFAULT") ?? "claude-sonnet-5-5");
  const max_tokens = Math.min(Math.max(Number(body.max_tokens) || 16000, 256), 32000);
  // A IA "pensa" escondida antes de escrever; isso gasta o limite de tamanho e deixa tudo lento.
  // Tenta do ajuste mais rápido ao padrão; se a Anthropic recusar um ajuste (erro 400), tenta o próximo.
  const variants: Record<string, unknown>[] =
    tier === "quick" ? [
      { thinking: { type: "disabled" }, output_config: { effort: "medium" } },
      { thinking: { type: "disabled" } },
      { output_config: { effort: "low" } },
      {},
    ] : tier === "default" ? [
      { thinking: { type: "between_tools" }, output_config: { effort: "medium" } },
      { thinking: { type: "disabled" } },
      { output_config: { effort: "low" } },
      {},
    ] : [
      { output_config: { effort: "medium" } },
      {},
    ];
  const call = (v: Record<string, unknown>) => fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, max_tokens: Object.keys(v).length ? max_tokens : 32000, system: SYSTEM, messages: body.messages, stream: true, ...v }),
  });
  let r!: Response; let used = "padrão"; const recusados: string[] = [];
  for (const v of variants) {
    r = await call(v);
    used = JSON.stringify(v);
    if (r.status !== 400) break;
    const t = await r.clone().text().catch(() => "");
    if (!/thinking|effort|output_config|disabled|between_tools/i.test(t)) break;
    recusados.push(used + " → " + t.slice(0, 160));
  }

  if (!r.ok || !r.body) {
    const txt = await r.text().catch(() => "");
    return new Response(txt || JSON.stringify({ error: "upstream" }), {
      status: r.status === 429 || r.status === 529 ? r.status : 502,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // 3) Devolve o texto em tempo real para o site (com um aviso inicial e um "sinal de vida" a cada 10 s)
  const enc = new TextEncoder();
  const info = { type: "evo_info", fn: "13/11 (1)", model, ajuste: used, recusados };
  const upstream = r.body.getReader();
  let beat: number | undefined;
  const out = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(`event: evo_info\ndata: ${JSON.stringify(info)}\n\n`));
      beat = setInterval(() => { try { c.enqueue(enc.encode(": vivo\n\n")); } catch { /* fechado */ } }, 10000);
    },
    async pull(c) {
      try {
        const { done, value } = await upstream.read();
        if (done) { clearInterval(beat); c.close(); return; }
        c.enqueue(value);
      } catch (e) { clearInterval(beat); c.error(e); }
    },
    cancel() { clearInterval(beat); upstream.cancel().catch(() => {}); },
  });
  return new Response(out, {
    headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
});
