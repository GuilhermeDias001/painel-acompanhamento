// Quadro do dia real (aba dd-mm-aaaa do Nova Operação) e histórico para a sugestão por lâmpada.
// Pedido do ENG-A/Guilherme 06/10. Colunas achadas pelo CABEÇALHO (o layout das abas mudou 3 vezes).
// Valor entra a partir de 06/10 (Guilherme: o valor é visto na hora do pagamento, todos podem editar).
// NUNCA lê Chave Pix.
const txt = (v) => (v == null ? '' : String(v)).trim();
const semAcento = (s) => txt(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
const letra = (i) => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const hhmm = (v) => { if (typeof v !== 'number') return txt(v); const m = Math.round((v % 1) * 1440); return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
export const nomeDaAba = (d) => `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;
export const dataDaAba = (nome) => { const m = /^(\d\d)-(\d\d)-(\d{4})$/.exec(nome); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };

// Lê uma aba de dia e devolve as linhas que têm loja (cada linha com `valor` numérico ou null). `ler(aba, 'A1:Z1')` -> matriz de valores.
export async function lerDia(ler, aba, ate = 300) {
  let cab;
  try { cab = (await ler(aba, 'A1:AB1'))[0]; } catch { return null; }
  const idx = {}; // título normalizado -> lista de colunas (títulos repetem: SAIDA, SALDO)
  cab.forEach((t, i) => { const k = semAcento(t); if (k) (idx[k] ||= []).push(i); });
  const um = (k) => idx[k]?.[0] ?? -1;
  const colab = um('COLABORADOR/REPOSICAO'), valor = um('VALOR'), status = um('STATUS'), tipo = um('TIPO'), loja = um('LOJA'),
    entrada = um('ENTRADA'), motivo = um('MOTIVO'), faltante = um('FALTANTE'), obs = um('OBSERVACAO');
  const comeca = (p) => cab.findIndex((t) => semAcento(t).startsWith(p)); // TEMPO INICIO / TEMPO FINAL: carimbo do tempo em aberto (só leitura)
  const tIni = comeca('TEMPO INIC'), tFim = comeca('TEMPO FIN');
  // a SAIDA do turno é a que vem DEPOIS de ENTRADA (a anterior é a saída real do titular)
  const saida = (idx.SAIDA || []).find((i) => i > entrada) ?? -1;
  const quer = [colab, valor, status, tipo, loja, entrada, saida, motivo, faltante, obs, tIni, tFim].filter((i) => i >= 0).sort((a, b) => a - b);
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
    const vl = g(valor);
    linhas.push({ colab: txt(g(colab)), status: txt(g(status)), valor: typeof vl === 'number' ? vl : null, tipo: txt(g(tipo)), loja: txt(g(loja)),
      entrada: hhmm(g(entrada)), saida: hhmm(g(saida)), motivo: txt(g(motivo)), faltante: txt(g(faltante)), obs: txt(g(obs)),
      inicio: typeof g(tIni) === 'number' ? g(tIni) : null, fim: typeof g(tFim) === 'number' ? g(tFim) : null });
  }
  return linhas;
}

// Aba "DOMINGO dd-mm-aaaa": lista à parte de quem trabalha só aos domingos (colunas: A loja, B "HH:MM as HH:MM", C frequência, D CHAVE PIX,
// E colaborador, F tipo, G valor, H cadastro). NUNCA lê a coluna D (Pix). Devolve as linhas no mesmo formato de lerDia, para juntar ao dia.
export async function lerDomingo(ler, aba, ate = 300) {
  let a, b;
  try { a = await ler(aba, `A2:C${ate}`); b = await ler(aba, `E2:H${ate}`); } catch { return null; }
  const tipos = new Set(['CLT', 'MEI', 'PRESTADOR', 'ELITE', 'BASE']);
  const linhas = [];
  a.forEach((l, i) => {
    const loja = txt(l[0]); if (!loja) return;
    const r = b[i] || [];
    const m = /(\d{1,2}):(\d{2})\s*(?:as|às|a|-)\s*(\d{1,2}):(\d{2})/i.exec(txt(l[1]));
    const tipo = txt(r[1]).toUpperCase();
    linhas.push({ colab: txt(r[0]), status: '', valor: typeof r[2] === 'number' ? r[2] : null, tipo: tipos.has(tipo) ? tipo : '', loja,
      entrada: m ? `${m[1].padStart(2, '0')}:${m[2]}` : '', saida: m ? `${m[3].padStart(2, '0')}:${m[4]}` : '', motivo: 'ESPORADICO FIXO',
      faltante: '', obs: `DOMINGO (${txt(l[2]) || 'frequência não informada'})${txt(r[3]) ? ' · cadastro: ' + txt(r[3]) : ''}`, inicio: null, fim: null });
  });
  return linhas;
}
const ehDomingo = (iso) => !!iso && new Date(iso + 'T12:00:00Z').getUTCDay() === 0;
// Dia completo: aba do dia + (aos domingos, quando existir) a aba "DOMINGO dd-mm-aaaa" juntada ao final
export async function lerDiaCompleto(ler, nome, abas) {
  const l = await lerDia(ler, nome);
  if (!l || !abas || !ehDomingo(dataDaAba(nome))) return l;
  const d = abas.find((x) => x.trim().toUpperCase() === `DOMINGO ${nome}`);
  if (!d) return l;
  const dom = await lerDomingo(ler, d);
  return dom?.length ? [...l, ...dom] : l;
}

export async function montarQuadro(ler, hojeNome, amanhaNome, abas) {
  const q = {};
  const h = await lerDiaCompleto(ler, hojeNome, abas);
  if (h) q.hoje = { data: dataDaAba(hojeNome), linhas: h };
  const a = await lerDiaCompleto(ler, amanhaNome, abas);
  if (a) q.planejamento = { data: dataDaAba(amanhaNome), linhas: a };
  return q;
}

// Histórico dos últimos `dias` dias (só linhas com colaborador e loja), com cache por data:
// dias passados não mudam, então cada aba é lida uma vez só. cache = { 'AAAA-MM-DD': linhas }.
export async function montarHistorico(ler, nomesAbas, hojeIso, cache, dias = 60, limite = 12) {
  const alvo = nomesAbas.map((n) => [n, dataDaAba(n)]).filter(([, d]) => d && d < hojeIso).sort((a, b) => b[1].localeCompare(a[1])).slice(0, dias);
  let lidos = 0;
  for (const [nome, data] of alvo) {
    // cache velho (sem motivo/faltante, que a tela Ponto e Faltas precisa) é relido; `limite`: no máximo N abas por execução
    if ((cache[data] && cache[data].every((x) => 'faltante' in x)) || lidos >= limite) continue;
    const l = await lerDiaCompleto(ler, nome, nomesAbas); // domingos juntam a aba "DOMINGO dd-mm-aaaa"
    // linha com colaborador OU com faltante (vaga em aberto de quem faltou também é falta); sem valor/Pix
    cache[data] = (l || []).filter((x) => x.loja && (x.colab || x.faltante)).map(({ loja, colab, entrada, saida, status, motivo, faltante }) => ({ data, loja, colab, entrada, saida, status, motivo, faltante }));
    lidos++;
  }
  const manter = new Set(alvo.map(([, d]) => d));
  for (const k of Object.keys(cache)) if (!manter.has(k)) delete cache[k];
  return { linhas: Object.keys(cache).sort().flatMap((k) => cache[k]), dias: Object.keys(cache).length, pendentes: alvo.filter(([, d]) => !cache[d]).length };
}
