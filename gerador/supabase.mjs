// Grava o painel no Supabase (projeto "Interno Tuf", São Paulo), tabela public.painel:
// uma linha por área, com `versao` = sha256 do conteúdo. A página com login lê só as áreas
// cuja versão mudou. Gravação com a chave secreta (segredo SUPABASE_SECRET do GitHub);
// leitura só para usuários logados (RLS).
import { createHash } from 'node:crypto';

export const SUPABASE_URL = 'https://jetujppwmyzyfkaflplj.supabase.co';

export function areasDe(d) {
  return {
    // meta muda a cada execução e é pequena; as outras só mudam quando o conteúdo muda
    meta: { geradoEm: d.geradoEm },
    farmo: { ultimoRegistro: d.ultimoRegistro, padrao: d.padrao, anos: d.anos,
      entregasMes: d.entregasMes, devolucoes: d.devolucoes, periodos: d.periodos },
    motoristas: d.cadastroMotoristas,
    rh: d.cadastroRH,
    operacao: d.operacao,
    planejamento: d.planejamento,
    mapa: d.mapa,
    contratos: d.contratos,
    colaboradores: d.colaboradores,
    quadro: d.quadro,
    historico_quadro: d.historicoQuadro,
    fixos: d.fixos,
    farmo_op: d.farmoOp,
    // flags e parâmetros do sistema; auditoria=true liga o INSERT em public.quadro_auditoria no site
    config: { auditoria: true, diaOperacional: d.diaOperacional, viradaDoDia: d.viradaDoDia },
  };
}

// Transição do quadro para o banco (pronta, desligada). Liga quando existir a área 'transicao' = {aPartirDe:'AAAA-MM-DD'} na tabela painel.
// A partir dessa data, cada dia (hoje e amanhã) que ainda não tem linha em quadro_dia é criado AQUI, uma única vez, copiando a aba do Excel.
// Depois de criado, o banco é a fonte da verdade desse dia: o gerador nunca mais o toca (edições do site não são sobrescritas).
export async function semearQuadro(dados, segredo) {
  const h = { apikey: segredo, 'Content-Type': 'application/json' };
  if (segredo.startsWith('eyJ')) h.Authorization = 'Bearer ' + segredo;
  const get = async (p) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: h }); if (!r.ok) throw new Error(`HTTP ${r.status} ${p}`); return r.json(); };
  const t = (await get('painel?select=dados&area=eq.transicao'))[0]?.dados;
  if (!t?.aPartirDe) return 'Quadro no banco: desligado';
  const feitos = [];
  for (const k of ['hoje', 'planejamento']) {
    const q = dados.quadro?.[k];
    if (!q?.data || q.data < t.aPartirDe || !q.linhas?.length) continue;
    if ((await get(`quadro_dia?select=dia&dia=eq.${q.data}`)).length) continue;
    const rd = await fetch(`${SUPABASE_URL}/rest/v1/quadro_dia`, { method: 'POST', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify({ dia: q.data, fonte: 'sistema' }) });
    if (!rd.ok) throw new Error(`quadro_dia HTTP ${rd.status}: ${(await rd.text()).slice(0, 150)}`);
    // carimbos do Excel (serial de data/hora, ou só hora no layout antigo) -> instante em UTC (SP = UTC-3)
    const [ya, ma, da] = q.data.split('-').map(Number);
    const inst = (v) => (typeof v !== 'number' ? null : new Date(v >= 1 ? (v - 25569) * 86400000 + 3 * 3600000 : Date.UTC(ya, ma - 1, da) + v * 86400000 + 3 * 3600000).toISOString());
    const rows = q.linhas.map((l, i) => ({ dia: q.data, ordem: i, loja: l.loja || '', colab: l.colab || '', status: l.status || '', motivo: l.motivo || '', tipo: l.tipo || '',
      valor: typeof l.valor === 'number' ? l.valor : null, entrada: l.entrada || '', saida: l.saida || '', faltante: l.faltante || '', obs: l.obs || '', origem_edicao: 'seed', inicio_em: inst(l.inicio), fim_em: inst(l.fim), status_anterior: l.status || '' }));
    const rl = await fetch(`${SUPABASE_URL}/rest/v1/quadro_linha`, { method: 'POST', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify(rows) });
    if (!rl.ok) throw new Error(`quadro_linha HTTP ${rl.status}: ${(await rl.text()).slice(0, 150)}`);
    feitos.push(`${q.data} (${rows.length} linhas)`);
  }
  return feitos.length ? 'Quadro no banco: criado ' + feitos.join(', ') : 'Quadro no banco: nada a criar';
}

export async function gravarSupabase(dados, segredo) {
  const linhas = Object.entries(areasDe(dados))
    .filter(([, v]) => v !== undefined)
    .map(([area, v]) => ({ area, dados: v, versao: createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16), atualizado_em: new Date().toISOString() }));
  // só regrava as áreas que mudaram: compara com as versões guardadas
  // chave nova (sb_secret_...) vai só no apikey; a antiga (service_role, um JWT) vai também no Authorization
  const h = { apikey: segredo, 'Content-Type': 'application/json' };
  if (segredo.startsWith('eyJ')) h.Authorization = 'Bearer ' + segredo;
  const ra = await fetch(`${SUPABASE_URL}/rest/v1/painel?select=area,versao`, { headers: h });
  if (!ra.ok) throw new Error(`Supabase leitura HTTP ${ra.status}: ${(await ra.text()).slice(0, 200)}`);
  const atuais = await ra.json();
  const ver = new Map((Array.isArray(atuais) ? atuais : []).map((x) => [x.area, x.versao]));
  const mudaram = linhas.filter((l) => ver.get(l.area) !== l.versao);
  if (!mudaram.length) return 'Supabase: nada mudou';
  const r = await fetch(`${SUPABASE_URL}/rest/v1/painel?on_conflict=area`, {
    method: 'POST', headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(mudaram),
  });
  if (!r.ok) throw new Error(`Supabase HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return 'Supabase: ' + mudaram.map((l) => l.area).join(', ');
}

// Ingestão dos dias FECHADOS do Excel para o banco (Guilherme, 08/10): a cada ciclo, todo dia da aba Nova Operação entre a data de início
// (painel.area='ingestao' = {de:'AAAA-MM-DD'}) e ontem que ainda não está em quadro_dia é copiado para quadro_dia/quadro_linha (fonte 'excel',
// origem_edicao 'seed': sem poluir a auditoria). Depois de gravado o banco é a fonte desse dia: o gerador nunca o regrava e as correções
// são feitas direto no banco. Lê no máximo `limite` dias por execução (o resto entra nas próximas).
export async function ingerirDiasFechados(ler, nomesAbas, hojeIso, segredo, limite = 15) {
  const h = { apikey: segredo, 'Content-Type': 'application/json' };
  if (segredo.startsWith('eyJ')) h.Authorization = 'Bearer ' + segredo;
  const get = async (p) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: h }); if (!r.ok) throw new Error(`HTTP ${r.status} ${p.slice(0, 40)}`); return r.json(); };
  const post = async (tabela, corpo) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${tabela}`, { method: 'POST', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify(corpo) }); if (!r.ok) throw new Error(`${tabela} HTTP ${r.status}: ${(await r.text()).slice(0, 150)}`); };
  const cfg = (await get('painel?select=dados&area=eq.ingestao'))[0]?.dados;
  if (!cfg?.de) return 'Ingestão do quadro: desligada';
  const { lerDiaCompleto, dataDaAba } = await import('./quadro.mjs');
  const ja = new Set((await get(`quadro_dia?select=dia&dia=gte.${cfg.de}&dia=lt.${hojeIso}&limit=1000`)).map((x) => x.dia));
  const alvo = nomesAbas.map((n) => [n, dataDaAba(n)]).filter(([, d]) => d && d >= cfg.de && d < hojeIso && !ja.has(d)).sort((a, b) => a[1].localeCompare(b[1]));
  const feitos = [], vazios = [];
  for (const [nome, dia] of alvo.slice(0, limite)) {
    const linhas = await lerDiaCompleto(ler, nome, nomesAbas);
    if (!linhas?.length) { vazios.push(dia); continue; }
    const [ya, ma, da] = dia.split('-').map(Number);
    const inst = (v) => (typeof v !== 'number' ? null : new Date(v >= 1 ? (v - 25569) * 86400000 + 3 * 3600000 : Date.UTC(ya, ma - 1, da) + v * 86400000 + 3 * 3600000).toISOString());
    const rows = linhas.map((l, i) => ({ dia, ordem: i, loja: l.loja || '', colab: l.colab || '', status: l.status || '', motivo: l.motivo || '', tipo: l.tipo || '',
      valor: typeof l.valor === 'number' ? l.valor : null, entrada: l.entrada || '', saida: l.saida || '', faltante: l.faltante || '', obs: l.obs || '', origem_edicao: 'seed',
      inicio_em: inst(l.inicio), fim_em: inst(l.fim), status_anterior: l.status || '' }));
    await post('quadro_dia', { dia, fonte: 'excel' });
    try { for (let i = 0; i < rows.length; i += 400) await post('quadro_linha', rows.slice(i, i + 400)); }
    catch (e) { await fetch(`${SUPABASE_URL}/rest/v1/quadro_linha?dia=eq.${dia}`, { method: 'DELETE', headers: h }); await fetch(`${SUPABASE_URL}/rest/v1/quadro_dia?dia=eq.${dia}`, { method: 'DELETE', headers: h }); throw e; }
    feitos.push(`${dia}(${rows.length})`);
  }
  return `Ingestão do quadro: ${feitos.length ? feitos.join(' ') : 'nada novo'}${vazios.length ? ' | abas sem linhas: ' + vazios.join(' ') : ''}${alvo.length > limite ? ` | faltam ${alvo.length - limite}` : ''}`;
}
