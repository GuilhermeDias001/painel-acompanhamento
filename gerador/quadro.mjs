// Quadro do dia real (aba dd-mm-aaaa do Nova Operação) e histórico para a sugestão por lâmpada.
// Pedido do ENG-A/Guilherme 06/10. Colunas achadas pelo CABEÇALHO (o layout das abas mudou 3 vezes).
// NUNCA lê Chave Pix nem Valor (pagamento fica fora do site até existir perfil financeiro).
const txt = (v) => (v == null ? '' : String(v)).trim();
const semAcento = (s) => txt(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
const letra = (i) => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const hhmm = (v) => { if (typeof v !== 'number') return txt(v); const m = Math.round((v % 1) * 1440); return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
export const nomeDaAba = (d) => `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;
export const dataDaAba = (nome) => { const m = /^(\d\d)-(\d\d)-(\d{4})$/.exec(nome); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };

// Lê uma aba de dia e devolve as linhas que têm loja. `ler(aba, 'A1:Z1')` -> matriz de valores.
export async function lerDia(ler, aba, ate = 300) {
  let cab;
  try { cab = (await ler(aba, 'A1:AB1'))[0]; } catch { return null; }
  const idx = {}; // título normalizado -> lista de colunas (títulos repetem: SAIDA, SALDO)
  cab.forEach((t, i) => { const k = semAcento(t); if (k) (idx[k] ||= []).push(i); });
  const um = (k) => idx[k]?.[0] ?? -1;
  const colab = um('COLABORADOR/REPOSICAO'), status = um('STATUS'), tipo = um('TIPO'), loja = um('LOJA'),
    entrada = um('ENTRADA'), motivo = um('MOTIVO'), faltante = um('FALTANTE'), obs = um('OBSERVACAO');
  // a SAIDA do turno é a que vem DEPOIS de ENTRADA (a anterior é a saída real do titular)
  const saida = (idx.SAIDA || []).find((i) => i > entrada) ?? -1;
  const quer = [colab, status, tipo, loja, entrada, saida, motivo, faltante, obs].filter((i) => i >= 0).sort((a, b) => a - b);
  if (loja < 0 || !quer.length) return [];
  // uma leitura por faixa contínua de colunas necessárias (pula Valor e Chave Pix)
  const faixas = []; for (const i of quer) { const f = faixas.at(-1); if (f && i === f[1] + 1) f[1] = i; else faixas.push([i, i]); }
  const dados = {};
  for (const [a, b] of faixas) {
    const v = await ler(aba, `${letra(a)}2:${letra(b)}${ate}`);
    v.forEach((linha, r) => linha.forEach((x, j) => { (dados[r] ||= {})[a + j] = x; }));
  }
  const linhas = [];
  for (let r = 0; r < ate - 1; r++) {
    const d = dados[r]; if (!d || !txt(d[loja])) continue;
    const g = (i) => (i >= 0 ? d[i] : '');
    linhas.push({ colab: txt(g(colab)), status: txt(g(status)), tipo: txt(g(tipo)), loja: txt(g(loja)),
      entrada: hhmm(g(entrada)), saida: hhmm(g(saida)), motivo: txt(g(motivo)), faltante: txt(g(faltante)), obs: txt(g(obs)) });
  }
  return linhas;
}

export async function montarQuadro(ler, hojeNome, amanhaNome) {
  const q = {};
  const h = await lerDia(ler, hojeNome);
  if (h) q.hoje = { data: dataDaAba(hojeNome), linhas: h };
  const a = await lerDia(ler, amanhaNome);
  if (a) q.planejamento = { data: dataDaAba(amanhaNome), linhas: a };
  return q;
}

// Histórico dos últimos `dias` dias (só linhas com colaborador e loja), com cache por data:
// dias passados não mudam, então cada aba é lida uma vez só. cache = { 'AAAA-MM-DD': linhas }.
export async function montarHistorico(ler, nomesAbas, hojeIso, cache, dias = 60, limite = 12) {
  const alvo = nomesAbas.map((n) => [n, dataDaAba(n)]).filter(([, d]) => d && d < hojeIso).sort((a, b) => b[1].localeCompare(a[1])).slice(0, dias);
  let lidos = 0;
  for (const [nome, data] of alvo) {
    if (cache[data] || lidos >= limite) continue; // `limite`: no máximo N abas novas por execução
    const l = await lerDia(ler, nome);
    cache[data] = (l || []).filter((x) => x.colab && x.loja).map(({ loja, colab, entrada, saida, status }) => ({ data, loja, colab, entrada, saida, status }));
    lidos++;
  }
  const manter = new Set(alvo.map(([, d]) => d));
  for (const k of Object.keys(cache)) if (!manter.has(k)) delete cache[k];
  return { linhas: Object.keys(cache).sort().flatMap((k) => cache[k]), dias: Object.keys(cache).length, pendentes: alvo.filter(([, d]) => !cache[d]).length };
}
