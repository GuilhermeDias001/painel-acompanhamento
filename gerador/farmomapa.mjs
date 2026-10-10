// Coordenadas das paradas da Farmoterápica para o mapa do site (pedido do ENG-A/Guilherme 10/10). Cada parada = endereço do cadastro de rotas
// (+ bairro da Operação). Geocodificação com a mesma infra do mapa das lojas (Nominatim, 1 pedido/s, cache cifrado). O traçado por estrada e o km são
// calculados no navegador. Vai só para a área logada 'farmo_mapa' do Supabase: nunca em dados.js nem dados.enc.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { nominatim, geocodificar } from './mapa.mjs';

const txt = (v) => (v == null ? '' : String(v)).trim();
const sem = (s) => txt(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ');

// Endereços completos vindos do TNS (tooltip do documento: "RUA X 353, BAIRRO, CIDADE-UF"), guardados em lojas-extra.json -> _farmo_enderecos [{cod, completo}].
// Casamento: mesmo código PNET (quando existe) + nomes de rua parecidos (tokens), como o script do Automa faz com a rua.
const TIPO = new Set(['RUA', 'R', 'AV', 'AVENIDA', 'AL', 'ALAMEDA', 'ESTRADA', 'EST', 'TRAV', 'TRAVESSA', 'PCA', 'PRACA', 'ROD', 'RODOVIA']);
const LIGACAO = new Set(['DE', 'DA', 'DO', 'DAS', 'DOS', 'E']);
const EXP = { DR: 'DOUTOR', DRA: 'DOUTORA', CAP: 'CAPITAO', MAJ: 'MAJOR', PROF: 'PROFESSOR', DEP: 'DEPUTADO', ENG: 'ENGENHEIRO', CEL: 'CORONEL', GEN: 'GENERAL', PRES: 'PRESIDENTE' };
const tokensRua = (s) => sem(String(s).split(',')[0]).replace(/[^A-Z0-9 ]/g, ' ').split(' ').filter(Boolean)
  .filter((t, i) => !(i === 0 && TIPO.has(t))).map((t) => EXP[t] || t)
  .filter((t) => !/^[0-9]+[A-Z]?$/.test(t) && t !== 'SN' && t !== 'S' && !LIGACAO.has(t)) // 'DE/DA/DO' não distinguem rua (Afonso DE Freitas x Herculano DE Freitas)
  .map((t) => t.replace(/([A-Z])\1/g, '$1')); // letras dobradas viram uma (MOTTA = MOTA)
// token igual, ou parecido (1 letra de diferença em palavras longas: ABRAMOWICH x ABRAMOWICZ)
const parecido = (x, y) => x === y || (x.length >= 6 && y.length >= 6 && Math.abs(x.length - y.length) <= 1 && dist1(x, y));
const dist1 = (x, y) => { if (x.length === y.length) { let d = 0; for (let i = 0; i < x.length; i++) if (x[i] !== y[i] && ++d > 1) return false; return true; } const [c, l] = x.length < y.length ? [x, y] : [y, x]; let i = 0, j = 0, d = 0; while (i < c.length && j < l.length) { if (c[i] === l[j]) { i++; j++; } else if (++d > 1) return false; else j++; } return true; };
const sim = (a, b) => { const A = [...new Set(a)], B = [...new Set(b)]; if (!A.length || !B.length) return 0; let i = 0; for (const t of A) if (B.some((u) => parecido(t, u))) i++; return i / Math.min(A.length, B.length); };
let COMPLETOS = null;
function carregarCompletos() {
  if (COMPLETOS) return COMPLETOS;
  try {
    const j = JSON.parse(readFileSync(new URL('./lojas-extra.json', import.meta.url), 'utf8'));
    COMPLETOS = (j._farmo_enderecos || []).map((x) => {
      const p = x.completo.split(',').map((v) => v.trim()); const cid = (p[p.length - 1] || '').replace(/-[A-Z]{2}$/, '');
      return { ...x, tokens: tokensRua(x.completo), bairro: p.length >= 3 ? p[p.length - 2] : '', cidade: cid };
    });
  } catch { COMPLETOS = []; }
  return COMPLETOS;
}
export { tokensRua, sim };
export function acharCompleto(endereco, cod) {
  const t = tokensRua(endereco); let melhor = null, ms = 0;
  for (const c of carregarCompletos()) { if (cod && c.cod && sem(cod) !== sem(c.cod)) continue; const v = sim(t, c.tokens); if (v > ms) { ms = v; melhor = c; } }
  return ms >= 0.6 ? melhor : null;
}
// acrescenta enderecoCompleto/bairroCompleto/cidade às linhas da Operação e ao cadastro de endereços da Farmo (o original continua em 'endereco')
export function completarEnderecos(farmoOp) {
  if (!farmoOp) return 0;
  const codPor = new Map();
  for (const l of farmoOp.operacaoHoje || []) if (l.codigoPnet && !codPor.has(sem(l.endereco))) codPor.set(sem(l.endereco), l.codigoPnet);
  let n = 0;
  const aplica = (o, cod) => { const c = acharCompleto(o.endereco, cod) || (cod ? null : acharCompleto(o.endereco, null)); if (!c) return; o.enderecoCompleto = c.completo; o.bairroCompleto = c.bairro; o.cidade = c.cidade; n++; };
  for (const l of farmoOp.operacaoHoje || []) aplica(l, l.codigoPnet);
  for (const x of farmoOp.enderecosPorRota || []) aplica(x, codPor.get(sem(x.endereco)));
  return n;
}

async function acharCompletoGeo(completo) {
  const p = completo.split(',').map((v) => v.trim());
  const cidade = (p[p.length - 1] || '').replace(/-([A-Z]{2})$/, ', $1');
  const rua = p[0].replace(/\s+(S\/N|SN)$/i, '').replace(/(\d+[A-Z]?)\/\d+[A-Z]?$/, '$1'); // 914/904 -> 914
  const semNum = rua.replace(/\s+[0-9]+[A-Z]?$/, '');
  const tent = [[`${rua}, ${cidade}`, 'numero'], [`${rua}, ${p[1] || ''}, ${cidade}`, 'numero'], [`${semNum}, ${cidade}`, 'rua'], [`${semNum}, ${p[1] || ''}, ${cidade}`, 'rua']];
  for (const [q, precisao] of tent) {
    const g = await nominatim(q).catch(() => null);
    if (g) return { ...g, fonte: precisao };
  }
  const r = await achar(p[0], p[1] || '');
  if (r) return r;
  if (p[1]) { const g = await nominatim(`${p[1]}, ${cidade}`).catch(() => null); if (g) return { ...g, fonte: 'bairro' }; } // último recurso: centro do bairro
  return null;
}

async function achar(endereco, bairro) {
  const rua = txt(endereco).replace(/\s+/g, ' ');
  const b = txt(bairro).replace(/\s+/g, ' ');
  // o bairro da planilha às vezes é cidade (GUARULHOS, DIADEMA...): vai na busca livre, limitada à Grande SP
  const tentativas = [[`${rua}, ${b}, São Paulo, SP`, 'rua+bairro'], [`${rua}, ${b}`, 'rua+bairro'], [`${rua}, São Paulo, SP`, 'rua']];
  for (const [q, precisao] of tentativas) {
    const g = await nominatim(q).catch(() => null);
    if (g) return { ...g, fonte: precisao };
  }
  return null;
}

export async function montarFarmoMapa({ farmoOp, base, cacheArq, limite = 100 }) {
  if (!farmoOp) return undefined;
  const cache = existsSync(cacheArq) ? JSON.parse(readFileSync(cacheArq, 'utf8')) : {};
  const bairroPor = new Map();
  for (const l of farmoOp.operacaoHoje || []) if (txt(l.endereco) && txt(l.bairro) && !bairroPor.has(sem(l.endereco))) bairroPor.set(sem(l.endereco), txt(l.bairro));
  // paradas = cadastro de endereços por rota; entram também as linhas da Operação que não estiverem no cadastro
  const vistos = new Set(), lista = [];
  const add = (rota, endereco, comp) => {
    const k = sem(rota) + '|' + sem(endereco); if (!txt(endereco) || vistos.has(k)) return; vistos.add(k);
    const p = { rota: txt(rota), endereco: txt(endereco), bairro: bairroPor.get(sem(endereco)) || '' };
    if (comp && comp.enderecoCompleto) { p.enderecoCompleto = comp.enderecoCompleto; p.bairro = comp.bairroCompleto || p.bairro; p.cidade = comp.cidade; }
    lista.push(p);
  };
  for (const x of farmoOp.enderecosPorRota || []) add(x.rota, x.endereco, x);
  for (const l of farmoOp.operacaoHoje || []) add(l.rota, l.endereco, l);
  let novos = 0; const paradas = [], semCoordenada = [];
  for (const p of lista) {
    const ck = p.enderecoCompleto ? `fm2|${sem(p.enderecoCompleto)}` : `fm1|${sem(p.endereco)}|${sem(p.bairro)}`;
    if (cache[ck] == null) { // inclui falhas anteriores (null): tenta de novo com as buscas melhoradas
      if (novos >= limite) { semCoordenada.push({ ...p, pendente: true }); continue; }
      cache[ck] = p.enderecoCompleto ? await acharCompletoGeo(p.enderecoCompleto) : await achar(p.endereco, p.bairro); novos++;
    }
    const g = cache[ck];
    if (!g) { semCoordenada.push(p); continue; }
    paradas.push({ ...p, lat: g.lat, lng: g.lng, precisao: g.fonte });
  }
  if (novos) writeFileSync(cacheArq, JSON.stringify(cache));
  // origem: a base (a Farmoterápica fica no mesmo local da Base, segundo o Guilherme). confirmada: o Guilherme definiu em 10/10 que a Base e a Farmoterápica ficam em Rua Marcelo Müller, 434.
  const origem = base ? { endereco: base.endereco, lat: base.lat, lng: base.lng, confirmada: true } : null;
  return { origem, paradas, semCoordenada, geradoEm: new Date().toISOString() };
}
