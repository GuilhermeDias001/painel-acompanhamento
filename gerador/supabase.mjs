// Grava o painel no Supabase (projeto "Interno Tuf", São Paulo), tabela public.painel:
// uma linha por área, com `versao` = sha256 do conteúdo. A página com login lê só as áreas
// cuja versão mudou. Gravação com a chave secreta (segredo SUPABASE_SECRET do GitHub);
// leitura só para usuários logados (RLS).
import { createHash } from 'node:crypto';

export const SUPABASE_URL = 'https://jetujppwmyzyfkaflplj.supabase.co';

export function areasDe(d) {
  return {
    farmo: { geradoEm: d.geradoEm, ultimoRegistro: d.ultimoRegistro, padrao: d.padrao, anos: d.anos,
      entregasMes: d.entregasMes, devolucoes: d.devolucoes, periodos: d.periodos },
    motoristas: d.cadastroMotoristas,
    rh: d.cadastroRH,
    operacao: d.operacao,
    planejamento: d.planejamento,
    mapa: d.mapa,
    fixos: d.fixos,
  };
}

export async function gravarSupabase(dados, segredo) {
  const linhas = Object.entries(areasDe(dados))
    .filter(([, v]) => v !== undefined)
    .map(([area, v]) => ({ area, dados: v, versao: createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16), atualizado_em: new Date().toISOString() }));
  // só regrava as áreas que mudaram: compara com as versões guardadas
  const h = { apikey: segredo, Authorization: 'Bearer ' + segredo, 'Content-Type': 'application/json' };
  const atuais = await (await fetch(`${SUPABASE_URL}/rest/v1/painel?select=area,versao`, { headers: h })).json();
  const ver = new Map((Array.isArray(atuais) ? atuais : []).map((x) => [x.area, x.versao]));
  const mudaram = linhas.filter((l) => ver.get(l.area) !== l.versao);
  if (!mudaram.length) return 'Supabase: nada mudou';
  const r = await fetch(`${SUPABASE_URL}/rest/v1/painel?on_conflict=area`, {
    method: 'POST', headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(mudaram),
  });
  if (!r.ok) throw new Error(`Supabase HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return 'Supabase: ' + mudaram.map((l) => l.area).join(', ');
}
