// Operação > Mapa: lojas da aba Contratos (Nova Operação) com coordenadas.
// Pedido do Guilherme via ENG-A (04/10); mapeamento em ponte/tarefas/20261004-lojas-tipo-endereco.
// Coordenadas: buscadas UMA vez por endereço e guardadas em geocache.json (no GitHub vai
// cifrado, geocache.enc). Fonte: BrasilAPI (CEP) e, sem coordenada lá, Nominatim (OSM).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const txt = (v) => (v == null ? '' : String(v)).trim();
const semAcento = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();

// Tipo pela rede (não há coluna na planilha). Editável: prefixo do nome, sem acento.
// Redes ambíguas ficam fora até o Guilherme definir.
const TIPOS = [
  ['farmacia', ['DROGA LESTE', 'NOVA FARMA', 'DROGANITA', 'DROGARIA KOBAYASHI', 'RS DROGARIA', 'ADG', 'DROGALIS',
    'CENTER DROGARIA TIBURCIO', 'FARMOTERAPICA', 'RD MANIPULAE']],
  ['petshop', ['DOGS DAY', 'BENIPET', 'BLUE PETS', 'PET SHOP SAO JOSE']],
  ['autopecas', ['4I AUTO PECA', 'ATN AUTO PECAS', 'AUTO PECAS PLACIN', 'IKEHARA', 'JMC', 'SP25', 'DIVAUTO', 'MASTECAR', 'MUNDIAL TRACTOR']],
];
// Rede = prefixo da lista TIPOS, com nome de exibição (Droga Leste 33 -> 'Droga Leste')
const NOME_REDE = { 'DROGA LESTE': 'Droga Leste', 'NOVA FARMA': 'Nova Farma', DROGANITA: 'Droganita', 'DROGARIA KOBAYASHI': 'Kobayashi',
  'RS DROGARIA': 'RS Drogaria', ADG: 'ADG Drogarias', DROGALIS: 'Drogalis', 'CENTER DROGARIA TIBURCIO': 'Center Tiburcio',
  FARMOTERAPICA: 'Farmoterápica', 'RD MANIPULAE': 'RD Manipulae', 'DOGS DAY': 'Dogs Day', BENIPET: 'Benipet', 'BLUE PETS': 'Blue Pets',
  'PET SHOP SAO JOSE': 'Pet Shop São José', '4I AUTO PECA': '4I Auto Peça', 'ATN AUTO PECAS': 'ATN Auto Peças',
  'AUTO PECAS PLACIN': 'Placin', IKEHARA: 'Ikehara', JMC: 'JMC', SP25: 'SP25', DIVAUTO: 'Divauto', MASTECAR: 'Mastecar', 'MUNDIAL TRACTOR': 'Mundial Tractor' };
const redeDe = (nome) => {
  const n = semAcento(nome);
  if (EXTRAS[n]?.rede) return EXTRAS[n].rede;
  for (const [, redes] of TIPOS) for (const r of redes) if (n.startsWith(r)) return NOME_REDE[r] || r;
  return '';
};
// Correcoes pesquisadas na web (lojas-extra.json, vem do cofre no CI): so confianca alta/media vale
const EXTRAS = (() => {
  try {
    const j = JSON.parse(readFileSync(new URL('./lojas-extra.json', import.meta.url), 'utf8'));
    return Object.fromEntries(Object.entries(j).filter(([k, v]) => !k.startsWith('_') && v.confianca !== 'baixa').map(([k, v]) => [semAcento(k), v]));
  } catch { return {}; }
})();
export const extraDe = (nome) => EXTRAS[semAcento(nome)] || null;
const tipoDe = (nome) => {
  const n = semAcento(nome);
  if (EXTRAS[n]?.tipo) return EXTRAS[n].tipo;
  if (n.startsWith('ESCRITORIO')) return null;
  for (const [tipo, redes] of TIPOS) if (redes.some((r) => n.startsWith(r))) return tipo;
  return null;
};
// vagas que juntam várias lojas ("82/91", "02, 12 E 14", "ORATORIO/JUVENTUS") não são um ponto
const ehGrupo = (nome) => /\//.test(nome) || /\d\s*(,|\bE\b)\s*\d/.test(semAcento(nome));

const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
// Pedidos ao Nominatim só dentro da Grande SP (viewbox), do mais preciso ao menos:
// rua+número+cidade, rua+cidade, e por fim o CEP (BrasilAPI), que costuma ser o centro da
// cidade (em 04/10, 58 lojas caíram no mesmo ponto). Endereço com várias lojas ("... / LOJA 2 - ...")
// usa o primeiro.
const GRANDE_SP = '-47.2,-23.0,-45.9,-24.2';
async function nominatim(q) {
  await espera(1100); // no máximo 1 pedido por segundo e identificação obrigatória
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&viewbox=${GRANDE_SP}&bounded=1&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'painel-tuf/1.0 (github.com/GuilhermeDias001/painel-acompanhamento)' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) return null;
  const j = await r.json();
  return j[0] ? { lat: +j[0].lat, lng: +j[0].lon } : null;
}
async function geocodificar(endereco) {
  const primeiro = endereco.replace(/^Endere[cç]o:\s*/i, '').split(/\s\/\s/)[0].trim();
  const cep = (primeiro.match(/(\d{5})-?(\d{3})/) || []).slice(1).join('');
  const semCep = primeiro.replace(/,?\s*\d{5}-?\d{3}.*$/, '');
  const m = semCep.match(/^(.+?),\s*(\d+)\s*-\s*([^,]+),\s*(.+?)\s*-\s*([A-Z]{2})\s*$/); // rua, nº - bairro, cidade - UF
  const tentativas = m
    ? [[`${m[1]}, ${m[2]}, ${m[4]}, ${m[5]}`, 'numero'], [`${m[1]}, ${m[4]}, ${m[5]}`, 'rua']]
    : [[semCep, 'rua']];
  for (const [q, precisao] of tentativas) {
    const g = await nominatim(q).catch(() => null);
    if (g) return { ...g, fonte: precisao };
  }
  if (cep.length === 8) {
    try {
      const r = await fetch(`https://brasilapi.com.br/api/cep/v2/${cep}`, { signal: AbortSignal.timeout(15000) });
      if (r.ok) {
        const c = (await r.json()).location?.coordinates || {};
        if (c.latitude && c.longitude) return { lat: +c.latitude, lng: +c.longitude, fonte: 'cep-aproximado' };
      }
    } catch { /* sem coordenada */ }
  }
  return null;
}

// contratos: linhas [B, R, T, U] (nome, endereço, bairro, região) da aba Contratos
export async function montarMapa({ contratos, dia, operacao, cacheArq }) {
  const cache = existsSync(cacheArq) ? JSON.parse(readFileSync(cacheArq, 'utf8')) : {};
  let novos = 0;
  const lojas = new Map();
  for (const [b, r, t, u] of contratos) {
    // corrigeEndereco: a correção feita aqui vale mais que o endereço da planilha (decisão do Guilherme 08/10: as correções ficam no sistema)
    const ex = extraDe(b), nome = txt(b), endereco = (ex?.corrigeEndereco && ex.endereco) || txt(r) || ex?.endereco || '';
    if (!nome || !endereco || lojas.has(nome) || ehGrupo(nome)) continue;
    const tipo = tipoDe(nome);
    if (!tipo || tipo === 'outro') continue; // 'outro' (banco de sangue, grafica...) nao vai no mapa
    lojas.set(nome, { nome, tipo, endereco, bairro: txt(t), regiao: txt(u) });
  }
  // Status (Guilherme, 04/10): 'cadastrada' = sem vaga hoje na DIA ATUAL; 'fechada' = tem vaga e
  // todas resolvidas (CONFIRMADO, FOLGA, CONFIRMADO RETORNO); 'aberta' = alguma vaga em aberto ou
  // pendente, com o tempo em aberto quando a Operação o calcula. A página pinta pelo tempo.
  const RESOLVIDO = ['CONFIRMADO', 'FOLGA', 'CONFIRMADO RETORNO'];
  const vagas = new Map();
  for (const l of dia) {
    const k = semAcento(txt(l.D));
    if (!k) continue;
    const v = vagas.get(k) || { total: 0, abertas: 0 };
    v.total++;
    if (!RESOLVIDO.includes(semAcento(txt(l.J)))) v.abertas++;
    vagas.set(k, v);
  }
  const aberto = new Map((operacao?.lojasEmAberto || []).map((x) => [semAcento(x.loja), x.tempo]));
  const saida = [];
  for (const l of lojas.values()) {
    const ck = 'v3|' + l.endereco; // v3: Nominatim rua+número na Grande SP (04/10)
    if (!(ck in cache)) {
      if (novos >= 100) continue; // limita cada execução; o resto entra nas próximas
      cache[ck] = await geocodificar(l.endereco).catch(() => null);
      novos++;
    }
    const g = cache[ck];
    if (!g) continue;
    const chave = semAcento(l.nome);
    const v = vagas.get(chave);
    const status = !v ? 'cadastrada' : v.abertas || aberto.has(chave) ? 'aberta' : 'fechada';
    const o = { nome: l.nome, rede: redeDe(l.nome), tipo: l.tipo, lat: g.lat, lng: g.lng, status, endereco: l.endereco, precisao: g.fonte };
    if (status === 'aberta' && aberto.get(chave)) o.tempo = aberto.get(chave);
    if (l.regiao) o.regiao = l.regiao;
    saida.push(o);
  }
  if (novos) writeFileSync(cacheArq, JSON.stringify(cache));
  // base da TUF (linha TUF LOGISTICA da aba Contratos do site; pedido do ENG-A 05/10)
  const base = { nome: 'TUF LOGISTICA', endereco: 'Rua Marcelo Müller, 434 - São Lucas, São Paulo - SP, 03222-020', lat: -23.5890937, lng: -46.5604703, regiao: 'Leste' };
  return { base, lojas: saida, semCoordenada: [...lojas.values()].filter((l) => cache['v3|' + l.endereco] === null).map((l) => l.nome) };
}

// Vagas e equipes por loja + loja/tipo/posição no cadastro do RH (casamento por nome sem acento).
// vagas: linhas [A funcionário, B loja, C posição] da Contratos; cadastro: [B nome, C status, D tipo].
const POSICAO = { TITULAR: 'Titular', FOLGUISTA: 'Folguista', 'ESPORADICO FIXO': 'Esporádico fixo', 'FIXO LOJA': 'Fixo loja',
  ELITE: 'Elite', BASE: 'Base', MOTO: 'Moto', MOTORISTA: 'Motorista', AJUDANTE: 'Ajudante' };
const TIPO = { CLT: 'CLT', MEI: 'MEI', PRESTADOR: 'Prestador', BASE: 'CLT', ELITE: 'CLT', SUPERVISOR: 'CLT' };
export function vincularEquipes({ mapa, vagas, cadastro, rh }) {
  const tipoDe = new Map(), ativo = new Map();
  for (const [n, st, t] of cadastro) {
    const k = semAcento(txt(n));
    if (!k || tipoDe.has(k)) continue;
    tipoDe.set(k, txt(t).toUpperCase());
    ativo.set(k, txt(st) !== 'Inativo');
  }
  const porLoja = new Map(), lojaDe = new Map();
  const hora = (v) => (typeof v === 'number' ? '' : txt(v));
  const pausa = (v) => { if (typeof v !== 'number' || v <= 0) return ''; const m = Math.round(v * 1440); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
  for (const linha of vagas) {
    const [f, b, c] = linha;
    const loja = txt(b);
    if (!loja) continue;
    const e = porLoja.get(loja) || { vagas: 0, equipe: [], detalhe: [] };
    e.vagas++;
    // vaga a vaga (colunas: D..I seg-sáb, J..N 1º-5º domingo, O pausa, Q obs, W modalidade, X função)
    e.detalhe.push({ titular: txt(f), tipoVaga: txt(c).toUpperCase(),
      horarios: { seg: hora(linha[3]), ter: hora(linha[4]), qua: hora(linha[5]), qui: hora(linha[6]), sex: hora(linha[7]), sab: hora(linha[8]),
        dom: [9, 10, 11, 12, 13].map((i) => hora(linha[i])) },
      pausa: pausa(linha[14]), obs: txt(linha[16]), modalidade: txt(linha[22]), funcao: txt(linha[23]) });
    const nome = txt(f), k = semAcento(nome);
    if (nome) {
      const t = tipoDe.get(k) || '';
      const pos = POSICAO[semAcento(txt(c))] || (t === 'ELITE' ? 'Elite' : t === 'BASE' ? 'Base' : txt(c));
      e.equipe.push({ nome, posicao: pos, tipo: TIPO[t] || '', ativo: ativo.get(k) !== false });
      if (!lojaDe.has(k)) lojaDe.set(k, { loja, posicao: pos });
    }
    porLoja.set(loja, e);
  }
  for (const l of mapa?.lojas || []) {
    const e = porLoja.get(l.nome);
    if (e) { l.vagas = e.vagas; l.equipe = e.equipe; l.vagasDetalhe = e.detalhe; }
  }
  for (const p of rh) {
    const k = semAcento(txt(p.nome)), v = lojaDe.get(k), t = tipoDe.get(k);
    if (v) p.loja = v.loja;
    if (t) p.tipo = TIPO[t] || '';
    // posição só para CLT (pedido do ENG-A); Base/Elite vêm do próprio tipo
    if (TIPO[t] === 'CLT') p.posicao = t === 'BASE' ? 'Base' : t === 'ELITE' ? 'Elite' : v?.posicao || '';
  }
}

// Contratos COMPLETO (todas as lojas e vagas da aba Contratos, com ou sem ponto no mapa).
// Pedido do Guilherme 06/10: "com escalas e tudo mais?". Colunas lidas: A:X e AR:AU (alternância).
// NUNCA Y (contato) e Z (telefone). `linhas` = A2:X760, `alt` = AR2:AU760 (mesmas linhas).
export function montarContratos({ linhas, alt, mapa }) {
  const hora = (v) => (typeof v === 'number' ? '' : txt(v));
  const pausa = (v) => { if (typeof v !== 'number' || v <= 0) return ''; const m = Math.round(v * 1440); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
  const noMapa = new Map((mapa?.lojas || []).map((l) => [l.nome, l]));
  const porLoja = new Map();
  linhas.forEach((l, i) => {
    const nome = txt(l[1]);
    if (!nome) return;
    const e = porLoja.get(nome) || { nome, endereco: '', bairro: '', regiao: '', vagasDetalhe: [] };
    if (!e.endereco && txt(l[17])) e.endereco = txt(l[17]);
    if (extraDe(nome)?.corrigeEndereco && extraDe(nome).endereco) { e.endereco = extraDe(nome).endereco; e.enderecoFonte = 'sistema'; }
    else if (!e.endereco && extraDe(nome)?.endereco) { e.endereco = extraDe(nome).endereco; e.enderecoFonte = 'web'; }
    if (!e.bairro && txt(l[19])) e.bairro = txt(l[19]);
    if (!e.regiao && txt(l[20])) e.regiao = txt(l[20]);
    const a = alt[i] || [];
    const v = { titular: txt(l[0]), tipoVaga: txt(l[2]).toUpperCase(),
      horarios: { seg: hora(l[3]), ter: hora(l[4]), qua: hora(l[5]), qui: hora(l[6]), sex: hora(l[7]), sab: hora(l[8]), dom: [9, 10, 11, 12, 13].map((k) => hora(l[k])) },
      pausa: pausa(l[14]), pausaExcecao: txt(l[15]), obs: txt(l[16]), modalidade: txt(l[22]), funcao: txt(l[23]) };
    // escalas alternadas (semana par/ímpar, domingo relativo): AR horário alt., AS sábado alt., AT fase, AU domingo relativo
    if (txt(a[0]) || txt(a[1]) || txt(a[2]) || txt(a[3])) v.alternancia = { horario: txt(a[0]), sabado: txt(a[1]), fase: txt(a[2]), domingo: txt(a[3]) };
    e.vagasDetalhe.push(v);
    porLoja.set(nome, e);
  });
  // Nome de loja que junta várias Droga Leste ("02 E 14", "70,73,74 E 75", "82/91", "64/65") não é uma loja:
  // é vaga de FOLGUISTA, que roda entre elas (Guilherme, 06/10: marcar apenas como Folguista).
  const grupoDL = (nome) => { const m = /^DROGA LESTE\s+(\d+(?:\s*(?:,|\/|E)\s*\d+)+)\s*$/i.exec(txt(nome)); return m ? [...m[1].matchAll(/\d+/g)].map((x) => 'DROGA LESTE ' + x[0].padStart(2, '0')) : null; };
  for (const e of porLoja.values()) {
    const g = grupoDL(e.nome);
    if (!g) continue;
    e.lojasDoGrupo = g;
    e.vagasDetalhe.forEach((v) => { v.tipoVaga = 'FOLGUISTA'; });
  }
  const lojas = [...porLoja.values()].map((e) => {
    const m = noMapa.get(e.nome);
    return { nome: e.nome, rede: m?.rede || redeDe(e.nome) || '', tipo: m?.tipo || tipoDe(e.nome) || '', endereco: e.endereco, bairro: e.bairro, regiao: e.regiao,
      ...(e.lojasDoGrupo ? { folguistaEntreLojas: e.lojasDoGrupo } : {}),
      ramo: extraDe(e.nome)?.ramo || '', enderecoFonte: e.enderecoFonte || '', vagas: e.vagasDetalhe.length, vagasDetalhe: e.vagasDetalhe, noMapa: !!m };
  });
  return { lojas, totais: { lojas: lojas.length, vagas: lojas.reduce((a, l) => a + l.vagas, 0) } };
}

// Cadastro de colaboradores da Nova Operação (aba Cadastro Colaboradores, cabeçalho na linha 2).
// Pedido do ENG-A/Guilherme 06/10. SEM telefone (E) e SEM chave Pix (G): entram só as colunas
// A cod, B nome, C status, D contrato, F admissão, H TUF Log, I status do TUF Log, J região,
// K trabalhando, L remanejamento. `linhas` = A3:L1500.
export function montarColaboradores(linhas) {
  const iso = (v) => { if (typeof v !== 'number' || v < 20000) return txt(v); return new Date((v - 25569) * 86400000).toISOString().slice(0, 10); };
  const tufStatus = (v) => { const s = txt(v).toLowerCase(); return s === 'aprovado' ? 'Aprovado' : s === 'pendente' ? 'Pendente' : ''; };
  const norm = (v, ...ok) => { const s = txt(v); return ok.find((o) => semAcento(o) === semAcento(s)) || s; };
  return linhas.filter((l) => txt(l[1])).map((l) => ({
    cod: txt(l[0]), nome: txt(l[1]), status: txt(l[2]) || 'Ativo', contrato: txt(l[3]).toUpperCase(), admissao: iso(l[5]),
    tufLog: txt(l[7]), tufLogStatus: tufStatus(l[8]), regiao: txt(l[9]) === 'Não informado' ? '' : txt(l[9]),
    trabalhando: norm(l[10], 'Sim', 'Não'), remanejamento: txt(l[11]).toUpperCase(),
  }));
}
