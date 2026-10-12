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
    farmo_mapa: d.farmoMapa,
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
    if (!rd.ok) throw new Error(`quadro_dia ${await erroSeguro(rd)}`);
    // carimbos do Excel (serial de data/hora, ou só hora no layout antigo) -> instante em UTC (SP = UTC-3)
    const [ya, ma, da] = q.data.split('-').map(Number);
    const inst = (v) => (typeof v !== 'number' ? null : new Date(v >= 1 ? (v - 25569) * 86400000 + 3 * 3600000 : Date.UTC(ya, ma - 1, da) + v * 86400000 + 3 * 3600000).toISOString());
    const rows = q.linhas.map((l, i) => ({ dia: q.data, ordem: i, loja: l.loja || '', colab: l.colab || '', status: l.status || '', motivo: l.motivo || '', tipo: l.tipo || '',
      valor: typeof l.valor === 'number' ? l.valor : null, entrada: l.entrada || '', saida: l.saida || '', faltante: l.faltante || '', obs: l.obs || '', origem_edicao: 'seed', inicio_em: inst(l.inicio), fim_em: inst(l.fim), status_anterior: l.status || '' }));
    const rl = await fetch(`${SUPABASE_URL}/rest/v1/quadro_linha`, { method: 'POST', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify(rows) });
    if (!rl.ok) throw new Error(`quadro_linha ${await erroSeguro(rl)}`);
    feitos.push(`${q.data} (${rows.length} linhas)`);
  }
  return feitos.length ? 'Quadro no banco: criado ' + feitos.join(', ') : 'Quadro no banco: nada a criar';
}

// Trava final (auditoria 11/10, C1): nenhum campo chamado pix/chave pix/pin chega ao banco, venha de onde vier.
const PROIBIDO = /^(pix|chave_?pix|chavepix|pin)$/i;
export function semProibidos(v) {
  if (Array.isArray(v)) return v.map(semProibidos);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !PROIBIDO.test(k)).map(([k, x]) => [k, semProibidos(x)]));
  return v;
}

// Erro de API para o log público do Actions: só código e mensagem curta, nunca o 'details' (o Postgres põe a linha inteira ali).
export async function erroSeguro(r) {
  let j = {}; try { j = JSON.parse(await r.text()); } catch { /* corpo não-JSON */ }
  return `HTTP ${r.status}${j.code ? ' ' + j.code : ''}${j.message ? ': ' + String(j.message).replace(/\(.*\)/g, '(…)').slice(0, 90) : ''}`;
}

export async function gravarSupabase(dados, segredo) {
  const linhas = Object.entries(semProibidos(areasDe(dados)))
    .filter(([, v]) => v !== undefined)
    .map(([area, v]) => ({ area, dados: v, versao: createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16), atualizado_em: new Date().toISOString() }));
  // só regrava as áreas que mudaram: compara com as versões guardadas
  // chave nova (sb_secret_...) vai só no apikey; a antiga (service_role, um JWT) vai também no Authorization
  const h = { apikey: segredo, 'Content-Type': 'application/json' };
  if (segredo.startsWith('eyJ')) h.Authorization = 'Bearer ' + segredo;
  const ra = await fetch(`${SUPABASE_URL}/rest/v1/painel?select=area,versao`, { headers: h });
  if (!ra.ok) throw new Error(`Supabase leitura ${await erroSeguro(ra)}`);
  const atuais = await ra.json();
  const ver = new Map((Array.isArray(atuais) ? atuais : []).map((x) => [x.area, x.versao]));
  // farmo_mapa nunca perde a origem (Farmoterápica/Base) nem fica vazio: se o gerador não achou, mantém o que já estava no banco (11/10)
  const fm = linhas.find((l) => l.area === 'farmo_mapa');
  if (fm) {
    try {
      const rv = await fetch(`${SUPABASE_URL}/rest/v1/painel?select=dados&area=eq.farmo_mapa`, { headers: h });
      const antigo = rv.ok ? (await rv.json())[0]?.dados : null;
      if (antigo) {
        if (!fm.dados.origem && antigo.origem) fm.dados.origem = antigo.origem;
        if (!(fm.dados.paradas || []).length && (antigo.paradas || []).length) { linhas.splice(linhas.indexOf(fm), 1); console.log('farmo_mapa: lista nova vazia, mantido o que já existia'); }
        else fm.versao = createHash('sha256').update(JSON.stringify(fm.dados)).digest('hex').slice(0, 16);
      }
    } catch { /* sem leitura: segue */ }
  }
  const mudaram = linhas.filter((l) => ver.get(l.area) !== l.versao);
  if (!mudaram.length) return 'Supabase: nada mudou';
  const r = await fetch(`${SUPABASE_URL}/rest/v1/painel?on_conflict=area`, {
    method: 'POST', headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(mudaram),
  });
  if (!r.ok) throw new Error(`Supabase ${await erroSeguro(r)}`);
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
  const post = async (tabela, corpo) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${tabela}`, { method: 'POST', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify(corpo) }); if (!r.ok) throw new Error(`${tabela} ${await erroSeguro(r)}`); };
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

// Importação ÚNICA do cadastro único (Guilherme autorizou em 12/10): grava cadastro_pessoa (dados que qualquer perfil lê) e
// cadastro_pessoa_pessoal (CPF, e-mail, telefones, endereço, placa: só admin/operador). NUNCA sobrescreve linha que já exista
// (decisões dele na fila 'Confirmar cadastro' valem mais): só completa o que falta. Controle por painel.area='import_cadastro'.
export async function importarCadastro(lista, segredo) {
  const h = { apikey: segredo, 'Content-Type': 'application/json' };
  if (segredo.startsWith('eyJ')) h.Authorization = 'Bearer ' + segredo;
  const get = async (p) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: h }); if (!r.ok) throw new Error(`leitura ${await erroSeguro(r)}`); return r.json(); };
  if ((await get('painel?select=area&area=eq.import_cadastro')).length) return 'Cadastro único: importação já feita';
  const antes = await get('cadastro_pessoa?select=chave&limit=5000');
  const jaTem = new Set(antes.map((x) => x.chave));
  const novos = lista.filter((p) => !jaTem.has(p.chave));
  const conflitos = lista.length - novos.length;
  const post = async (tabela, corpo) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${tabela}?on_conflict=chave`, { method: 'POST', headers: { ...h, Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(corpo) }); if (!r.ok) throw new Error(`${tabela} ${await erroSeguro(r)}`); };
  for (let i = 0; i < novos.length; i += 150) {
    const lote = novos.slice(i, i + 150);
    await post('cadastro_pessoa', lote.map((p) => ({ chave: p.chave, cod: p.cod || '', nome: p.nome, dados: p.dados, origem: p.origem || '' })));
    await post('cadastro_pessoa_pessoal', lote.filter((p) => p.pessoal && Object.keys(p.pessoal).length).map((p) => ({ chave: p.chave, dados: p.pessoal })));
  }
  const depois = await get('cadastro_pessoa?select=chave&limit=5000');
  const msg = `Cadastro único: ${lista.length} na lista, ${novos.length} gravadas, ${conflitos} já existiam (mantidas); antes ${antes.length}, depois ${depois.length}`;
  await fetch(`${SUPABASE_URL}/rest/v1/painel?on_conflict=area`, { method: 'POST', headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ area: 'import_cadastro', dados: { feito: new Date().toISOString(), resumo: msg }, versao: String(Date.now()), atualizado_em: new Date().toISOString() }]) });
  return msg;
}

// Fila de análise (Guilherme, 12/10: "olha apenas a Escala das lojas e preenche as vagas e os Elites; o restante vai para análise").
// ÚNICA vez (painel.area='import_analise'): 1) insere os registros em cadastro_pendente; 2) ESTACIONA em cadastro_pessoa_estacionada
// as pessoas que não ficam e as tira de cadastro_pessoa (os dados pessoais seguem em cadastro_pessoa_pessoal, sem FK, e voltam a casar
// pela chave se forem aprovadas). Nada é perdido: a linha completa fica na tabela estacionada.
export async function importarAnalise(obj, segredo) {
  const h = { apikey: segredo, 'Content-Type': 'application/json' };
  if (segredo.startsWith('eyJ')) h.Authorization = 'Bearer ' + segredo;
  const rest = (p) => `${SUPABASE_URL}/rest/v1/${p}`;
  const get = async (p) => { const r = await fetch(rest(p), { headers: h }); if (!r.ok) throw new Error(`leitura ${await erroSeguro(r)}`); return r.json(); };
  if ((await get('painel?select=area&area=eq.import_analise')).length) return 'Fila de análise: importação já feita';
  const paginar = async (p) => { const t = []; for (let o = 0; ; o += 1000) { const l = await get(`${p}&limit=1000&offset=${o}`); t.push(...l); if (l.length < 1000) break; } return t; };
  const ficam = new Set(obj.ficam);
  const pessoas = await paginar('cadastro_pessoa?select=*&order=chave');
  const pendAntes = (await paginar('cadastro_pendente?select=id&order=id')).length;
  const sair = pessoas.filter((p) => !ficam.has(p.chave));
  const faltam = [...ficam].filter((k) => !pessoas.some((p) => p.chave === k));
  if (faltam.length) throw new Error(`${faltam.length} chaves de 'ficam' não estão em cadastro_pessoa; abortado sem alterar nada`);
  if (obj.pendentes.length !== sair.length) throw new Error(`pendentes (${obj.pendentes.length}) ≠ pessoas a sair (${sair.length}); abortado sem alterar nada`);
  const post = async (tabela, corpo, extra = '') => { const r = await fetch(rest(tabela), { method: 'POST', headers: { ...h, Prefer: 'return=minimal' + extra }, body: JSON.stringify(corpo) }); if (!r.ok) throw new Error(`${tabela} ${await erroSeguro(r)}`); };
  // 1) estaciona (cópia completa) ANTES de apagar
  for (let i = 0; i < sair.length; i += 150) await post('cadastro_pessoa_estacionada?on_conflict=chave', sair.slice(i, i + 150).map((p) => ({ ...p, motivo: 'fora da Escala (vaga/Elite): vai para análise (12/10)' })), ',resolution=ignore-duplicates');
  const est = (await paginar('cadastro_pessoa_estacionada?select=chave&order=chave')).length;
  if (est < sair.length) throw new Error(`estacionadas ${est} < ${sair.length}; abortado antes de apagar`);
  // 2) fila
  for (let i = 0; i < obj.pendentes.length; i += 100) await post('cadastro_pendente', obj.pendentes.slice(i, i + 100).map((p) => ({ origem: p.origem, nome: p.nome, duvida: p.duvida, proposta: p.proposta, candidatos: p.candidatos || [], status: 'pendente' })));
  // 3) tira de cadastro_pessoa
  for (let i = 0; i < sair.length; i += 40) {
    const lista = sair.slice(i, i + 40).map((p) => `"${String(p.chave).replace(/"/g, '\\"')}"`).join(',');
    const r = await fetch(rest(`cadastro_pessoa?chave=in.(${encodeURIComponent(lista)})`), { method: 'DELETE', headers: { ...h, Prefer: 'return=minimal' } });
    if (!r.ok) throw new Error(`apagar ${await erroSeguro(r)}`);
  }
  const depoisP = (await paginar('cadastro_pessoa?select=chave&order=chave')).length;
  const pend = (await paginar('cadastro_pendente?select=id&status=eq.pendente&order=id')).length;
  const pess = (await paginar('cadastro_pessoa_pessoal?select=chave&order=chave')).length;
  const msg = `Fila de análise: pessoas ${pessoas.length} -> ${depoisP}; estacionadas ${est}; pendentes antes ${pendAntes}, pendentes agora ${pend}; pessoais ${pess}`;
  await fetch(rest('painel?on_conflict=area'), { method: 'POST', headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ area: 'import_analise', dados: { feito: new Date().toISOString(), resumo: msg }, versao: String(Date.now()), atualizado_em: new Date().toISOString() }]) });
  return msg;
}
