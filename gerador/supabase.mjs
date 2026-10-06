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
    const rows = q.linhas.map((l, i) => ({ dia: q.data, ordem: i, loja: l.loja || '', colab: l.colab || '', status: l.status || '', motivo: l.motivo || '', tipo: l.tipo || '',
      valor: typeof l.valor === 'number' ? l.valor : null, entrada: l.entrada || '', saida: l.saida || '', faltante: l.faltante || '', obs: l.obs || '', origem_edicao: 'seed' }));
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
