// Cópia fiel das abas legadas das planilhas para o banco (Guilherme, 10/10: "puxar todos os dados, menos Pix e PIN").
// Cada aba vira linhas em legado_linha {arquivo, aba, linha, dados:{coluna: valor}} + um registro em legado_aba. Só roda uma vez por aba.
// FICAM DE FORA: só as colunas cujo título case com PIX ou PIN (decisão do Guilherme, 10/10; ele liberou banco/agência/conta/favorecido e o Login do TUF Log). Liga com painel.area='importacao_legado' = {ativo:true}. Só no Actions (chave secreta).
import { SUPABASE_URL } from './supabase.mjs';

const EXCLUIR = /(^|[^a-z])(pix|pin)([^a-z]|$)/i; // Guilherme, 10/10: só Pix e PIN ficam de fora (banco/agência/conta/favorecido e Login foram liberados)
const LETRA = (i) => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const col = (l) => l.split('').reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
const iso = (s) => new Date((s - 25569) * 86400000).toISOString().slice(0, 10);

// arquivo: nova | farmo | acomp. colunas: 'A:Q' (cabeçalho na linha 1). nome = nome gravado para a aba.
export const ABAS = [
  { arquivo: 'nova', aba: 'Proibidos', colunas: 'A:F' },
  { arquivo: 'nova', aba: 'Remanejamento', colunas: 'A:K' },
  { arquivo: 'nova', aba: 'Hora Extra', colunas: 'A:G' },
  // Esporádicos Fixos NÃO é cópia à parte: são vagas dentro dos Contratos (Guilherme, 10/10) e já vêm de lá (tipoVaga ESPORADICO FIXO)
  { arquivo: 'nova', aba: 'TUF Log', colunas: 'A:F' },
  { arquivo: 'nova', aba: 'Escala', colunas: 'A:G' },
  { arquivo: 'nova', aba: 'BACKUP HISTORICO 17-19', colunas: 'A:Q' },
  { arquivo: 'nova', aba: 'Historico', colunas: 'A:Y' },
  { arquivo: 'nova', aba: 'Apoio', colunas: 'A:F' },
  { arquivo: 'farmo', aba: 'Borderô', colunas: 'A:H' },
  { arquivo: 'farmo', aba: 'Pagamento', colunas: 'A:H' },
  { arquivo: 'farmo', aba: 'Fechamento', colunas: 'A:L' },
  { arquivo: 'farmo', aba: 'Bolsa Multi', colunas: 'A:I' },
  { arquivo: 'acomp', aba: 'Historico', colunas: 'A:N' },
  { arquivo: 'acomp', aba: 'Historico Farmo', colunas: 'A:AB' },
  { arquivo: 'acomp', aba: 'Planos', colunas: 'A:E' },
  // entregas históricas da Farmoterápica (colunas T:AB da aba Historico; as colunas A:R já estão em farmo_operacao_linha/farmo_devolucao_linha)
  { arquivo: 'farmo', aba: 'Historico', colunas: 'T:AB', nome: 'Historico (entregas)' },
];

export async function importarLegado(lerPor, segredo, orcamento = 30000) {
  const seco = segredo === 'DRY'; // teste local: lê as planilhas, não grava nada
  const h = { apikey: segredo, 'Content-Type': 'application/json' };
  if (segredo.startsWith('eyJ')) h.Authorization = 'Bearer ' + segredo;
  const rest = (p) => `${SUPABASE_URL}/rest/v1/${p}`;
  const get = async (p) => { if (seco) return p.startsWith('painel') ? [{ dados: { ativo: true } }] : []; const r = await fetch(rest(p), { headers: h }); if (!r.ok) throw new Error(`HTTP ${r.status} ${p.slice(0, 40)}`); return r.json(); };
  const post = async (p, corpo, extra = '') => { if (seco) return; const r = await fetch(rest(p), { method: 'POST', headers: { ...h, Prefer: 'return=minimal' + extra }, body: JSON.stringify(corpo) }); if (!r.ok) throw new Error(`POST ${p.slice(0, 30)} HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`); };
  const cfg = (await get('painel?select=dados&area=eq.importacao_legado'))[0]?.dados;
  if (!cfg?.ativo) return 'Legado: desligado';
  const feitas = new Set((await get('legado_aba?select=arquivo,aba&limit=500')).map((x) => x.arquivo + '|' + x.aba));
  const log = []; let gastos = 0;
  for (const spec of ABAS) {
    const nome = spec.nome || spec.aba;
    if (feitas.has(spec.arquivo + '|' + nome)) continue;
    if (gastos >= orcamento) { log.push('(restante no próximo ciclo)'); break; }
    const ler = lerPor(spec.arquivo);
    const [c1, c2] = spec.colunas.split(':'), n1 = col(c1), n2 = col(c2);
    const cab = ((await ler(spec.aba, `${c1}1:${c2}1`))[0] || []).map((x) => String(x ?? '').trim());
    const chaves = [], vistos = {}, excluidas = [];
    cab.forEach((t, i) => {
      const letra = LETRA(n1 + i);
      if (t && EXCLUIR.test(t)) { excluidas.push(`${letra}:${t}`); chaves.push(null); return; }
      let k = t || letra; if (vistos[k]) k = `${k} (${letra})`; vistos[k] = 1; chaves.push(k);
    });
    const ehData = chaves.map((k) => k && /^(data|dia)\b/i.test(k));
    const linhas = []; let ini = 2, vazias = 0;
    while (vazias < 2 && ini < 60000) {
      const fim = ini + 1999, bloco = await ler(spec.aba, `${c1}${ini}:${c2}${fim}`);
      let achou = 0;
      bloco.forEach((l, i) => {
        const o = {}; let alguma = false;
        chaves.forEach((k, j) => { if (!k) return; let v = l[j]; if (v === '' || v == null) return; if (ehData[j] && typeof v === 'number' && v > 30000 && v < 70000) v = iso(v); o[k] = v; alguma = true; });
        if (alguma) { linhas.push({ arquivo: spec.arquivo, aba: nome, linha: ini + i, dados: o }); achou++; }
      });
      vazias = achou ? 0 : vazias + 1; ini += 2000;
      if (bloco.length < 2000 && !achou) break;
    }
    for (let i = 0; i < linhas.length; i += 800) await post('legado_linha?on_conflict=arquivo,aba,linha', linhas.slice(i, i + 800), ',resolution=ignore-duplicates');
    await post('legado_aba?on_conflict=arquivo,aba', [{ arquivo: spec.arquivo, aba: nome, intervalo: spec.colunas, cabecalho: cab.filter(Boolean), colunas_excluidas: excluidas, linhas: linhas.length }], ',resolution=ignore-duplicates');
    gastos += linhas.length;
    log.push(`${spec.arquivo}/${nome}: ${linhas.length}${excluidas.length ? ' (sem ' + excluidas.map((e) => e.split(':')[1]).join('/') + ')' : ''}`);
  }
  return 'Legado: ' + (log.length ? log.join(' | ') : 'nada novo');
}
