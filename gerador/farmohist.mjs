// Farmoterápica: planilha -> banco (decisão do Guilherme, 10/10).
//  1) HISTÓRICO inteiro: a aba Historico (A:J operação, L:R devolução) vira dias FECHADOS no banco; dia que já existe no banco só recebe o que está vazio.
//  2) DIA DE HOJE: os lançamentos do Excel só são copiados depois das 23:30 (SP) e SÓ onde o site não preencheu; o que foi preenchido no site prevalece.
// Liga com painel.area='ingestao_farmo' = {de:'AAAA-MM-DD'}. Roda só no Actions (precisa da chave secreta do Supabase). Nunca lê Pix/CPF (a aba Motorista não é tocada).
import { SUPABASE_URL } from './supabase.mjs';

const txt = (v) => (v == null ? '' : String(v)).trim();
const iso = (s) => (typeof s === 'number' && s > 30000 ? new Date((s - 25569) * 86400000).toISOString().slice(0, 10) : '');
const hhmm = (v) => { if (typeof v !== 'number') return txt(v); const m = Math.round((v % 1) * 1440); return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const turno = (t) => (/^TARDE/i.test(txt(t)) ? 'tarde' : /^MANH/i.test(txt(t)) ? 'manha' : '');

export async function sincronizarFarmo(ler, farmoOp, segredo) {
  const h = { apikey: segredo, 'Content-Type': 'application/json' };
  if (segredo.startsWith('eyJ')) h.Authorization = 'Bearer ' + segredo;
  const rest = (p) => `${SUPABASE_URL}/rest/v1/${p}`;
  const get = async (p) => { const r = await fetch(rest(p), { headers: h }); if (!r.ok) throw new Error(`HTTP ${r.status} ${p.slice(0, 50)}`); return r.json(); };
  const send = async (p, metodo, corpo, extra = '') => { const r = await fetch(rest(p), { method: metodo, headers: { ...h, Prefer: 'return=minimal' + extra }, body: JSON.stringify(corpo) }); if (!r.ok) throw new Error(`${metodo} ${p.slice(0, 40)} HTTP ${r.status}: ${(await r.text()).slice(0, 150)}`); };
  const cfg = (await get('painel?select=dados&area=eq.ingestao_farmo'))[0]?.dados;
  if (!cfg?.de) return 'Farmo histórico: desligado';
  const log = [];

  // ---------- 1) histórico (aba Historico) ----------
  const col = await ler('Historico', 'A2:A25000');
  const datas = col.map((l) => iso(l[0]));
  const todasDatas = [...new Set(datas.filter((d) => d && d >= cfg.de))].sort();
  const noBanco = new Set((await get(`farmo_dia?select=dia&dia=gte.${cfg.de}&limit=2000`)).map((x) => x.dia));
  // dias do histórico que o banco ainda não tem (entram inteiros) e dias que já tem (só completam o que está vazio, no máximo 5 por ciclo)
  const novos = todasDatas.filter((d) => !noBanco.has(d));
  if (novos.length) {
    const A = await ler('Historico', `A2:J${col.length + 1}`);
    const R = await ler('Historico', `L2:R${col.length + 1}`);
    const alvo = new Set(novos);
    const ops = [], devs = [], ordem = {};
    A.forEach((l) => {
      const dia = iso(l[0]); if (!alvo.has(dia) || !Number.isFinite(Number(l[1]))) return;
      ops.push({ dia, linha: Number(l[1]), rota: txt(l[9]), endereco: txt(l[2]), horario: hhmm(l[3]), bairro: txt(l[4]), codigo_pnet: txt(l[5]), sugestao: '', portador: txt(l[6]), bolsa: txt(l[7]), termometro: txt(l[8]) });
    });
    R.forEach((l) => {
      const dia = iso(l[0]), t = turno(l[1]); if (!alvo.has(dia) || !t) return;
      const k = dia + t; ordem[k] = (ordem[k] ?? -1) + 1;
      devs.push({ dia, turno: t, ordem: ordem[k], bolsa_p: txt(l[2]), bolsa_m: txt(l[3]), bolsa_g: txt(l[4]), termometro1: txt(l[5]), termometro2: txt(l[6]) });
    });
    for (let i = 0; i < novos.length; i += 200) await send('farmo_dia?on_conflict=dia', 'POST', novos.slice(i, i + 200).map((dia) => ({ dia, status: 'fechado' })), ',resolution=ignore-duplicates');
    for (let i = 0; i < ops.length; i += 800) await send('farmo_operacao_linha?on_conflict=dia,linha', 'POST', ops.slice(i, i + 800), ',resolution=ignore-duplicates');
    for (let i = 0; i < devs.length; i += 800) await send('farmo_devolucao_linha?on_conflict=dia,turno,ordem', 'POST', devs.slice(i, i + 800), ',resolution=ignore-duplicates');
    log.push(`histórico: ${novos.length} dias novos (${ops.length} linhas de operação, ${devs.length} de devolução)`);
  }

  // ---------- 2) hoje: Excel só depois das 23:30 e só onde o site não preencheu ----------
  const sp = new Date(Date.now() - 3 * 3600000), minutos = sp.getUTCHours() * 60 + sp.getUTCMinutes();
  const hojeSP = sp.toISOString().slice(0, 10);
  if (minutos >= 23 * 60 + 30 && farmoOp?.dataHoje === hojeSP && farmoOp.operacaoHoje?.length) {
    const dia = hojeSP;
    await send('farmo_dia?on_conflict=dia', 'POST', [{ dia, status: 'aberto' }], ',resolution=ignore-duplicates');
    const atuais = await get(`farmo_operacao_linha?select=id,linha,rota,endereco,horario,bairro,codigo_pnet,sugestao,portador,bolsa,termometro&dia=eq.${dia}&limit=1000`);
    const porLinha = new Map(atuais.map((x) => [x.linha, x]));
    const novas = [], completar = [];
    for (const x of farmoOp.operacaoHoje) {
      const b = porLinha.get(x.linha);
      if (!b) { novas.push({ dia, linha: x.linha, rota: x.rota, endereco: x.endereco, horario: x.horario, bairro: x.bairro, codigo_pnet: x.codigoPnet, sugestao: x.sugestao, portador: x.portador, bolsa: x.bolsa, termometro: x.termometro }); continue; }
      // site prevalece: só campo vazio no banco recebe o valor do Excel
      const p = {};
      for (const [campo, v] of [['portador', x.portador], ['bolsa', x.bolsa], ['termometro', x.termometro], ['sugestao', x.sugestao]]) if (!txt(b[campo]) && txt(v)) p[campo] = v;
      if (Object.keys(p).length) completar.push([b.id, p]);
    }
    for (let i = 0; i < novas.length; i += 800) await send('farmo_operacao_linha?on_conflict=dia,linha', 'POST', novas.slice(i, i + 800), ',resolution=ignore-duplicates');
    for (const [id, p] of completar) await send(`farmo_operacao_linha?id=eq.${id}`, 'PATCH', p);
    // devolução do dia: se o site não gravou nada, entra a do Excel; se gravou, só completa campos vazios por (turno, ordem)
    const dv = farmoOp.devolucaoHoje || {};
    const deExcel = [];
    for (const [t, lista] of [['manha', dv.manha || []], ['tarde', dv.tarde || []]]) lista.forEach((l, i) => deExcel.push({ dia, turno: t, ordem: i, bolsa_p: l.bolsaP, bolsa_m: l.bolsaM, bolsa_g: l.bolsaG, termometro1: l.termometro1, termometro2: l.termometro2 }));
    const devAtuais = await get(`farmo_devolucao_linha?select=id,turno,ordem,bolsa_p,bolsa_m,bolsa_g,termometro1,termometro2&dia=eq.${dia}&limit=500`);
    const dMap = new Map(devAtuais.map((x) => [x.turno + '|' + x.ordem, x]));
    const dNovas = [], dCompletar = [];
    for (const x of deExcel) {
      const b = dMap.get(x.turno + '|' + x.ordem);
      if (!b) { dNovas.push(x); continue; }
      const p = {};
      for (const c of ['bolsa_p', 'bolsa_m', 'bolsa_g', 'termometro1', 'termometro2']) if (!txt(b[c]) && txt(x[c])) p[c] = x[c];
      if (Object.keys(p).length) dCompletar.push([b.id, p]);
    }
    if (dNovas.length) await send('farmo_devolucao_linha?on_conflict=dia,turno,ordem', 'POST', dNovas, ',resolution=ignore-duplicates');
    for (const [id, p] of dCompletar) await send(`farmo_devolucao_linha?id=eq.${id}`, 'PATCH', p);
    log.push(`hoje ${dia} (23:30): ${novas.length} linhas novas, ${completar.length} completadas do Excel; devolução ${dNovas.length} novas, ${dCompletar.length} completadas`);
  }
  return 'Farmo: ' + (log.length ? log.join(' | ') : 'nada novo');
}
