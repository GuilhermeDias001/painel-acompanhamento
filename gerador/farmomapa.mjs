// Coordenadas das paradas da Farmoterápica para o mapa do site (pedido do ENG-A/Guilherme 10/10). Cada parada = endereço do cadastro de rotas
// (+ bairro da Operação). Geocodificação com a mesma infra do mapa das lojas (Nominatim, 1 pedido/s, cache cifrado). O traçado por estrada e o km são
// calculados no navegador. Vai só para a área logada 'farmo_mapa' do Supabase: nunca em dados.js nem dados.enc.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    // endereços de pacientes (auditoria 11/10): arquivo próprio, fora do OneDrive. No Actions vem do cofre (gerador/farmo-enderecos.json);
    // no PC fica em ~/.tuf-segredos/. O _farmo_enderecos antigo do lojas-extra.json só vale se nenhum dos dois existir.
    const caminhos = [new URL('./farmo-enderecos.json', import.meta.url), join(homedir(), '.tuf-segredos', 'farmo-enderecos.json')];
    const achado = caminhos.find((c) => existsSync(c));
    const lista = achado ? JSON.parse(readFileSync(achado, 'utf8'))
      : (JSON.parse(readFileSync(new URL('./lojas-extra.json', import.meta.url), 'utf8'))._farmo_enderecos || []);
    COMPLETOS = lista.map((x) => {
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

// Google Geocoding (segredo GOOGLE_GEOCODE_KEY no GitHub; a chave nunca vai para o log nem para o repositório).
// Só aceita resultado PRECISO (ROOFTOP = no endereço; RANGE_INTERPOLATED = no número, interpolado na rua) e sem partial_match.
// Centro de rua/bairro/cidade (GEOMETRIC_CENTER / APPROXIMATE) é recusado: fica "sem coordenada" (Guilherme, 10/10: sem aproximação).
let chamadasGoogle = 0;
const LIMITE_GOOGLE = 150; // trava de custo por execução
async function geocodificarGoogle(completo) {
  const key = process.env.GOOGLE_GEOCODE_KEY;
  if (!key || chamadasGoogle >= LIMITE_GOOGLE) return undefined; // undefined = Google indisponível
  const q = completo.replace(/-([A-Z]{2})$/, ', $1').replace(/\s+(S\/N|SN)\b/i, '') + ', Brasil';
  chamadasGoogle++;
  const r = await fetch('https://maps.googleapis.com/maps/api/geocode/json?' + new URLSearchParams({ address: q, components: 'country:BR', region: 'br', language: 'pt-BR', key }));
  if (!r.ok) throw new Error('Google HTTP ' + r.status);
  const j = await r.json();
  if (j.status === 'ZERO_RESULTS') return null;
  if (j.status !== 'OK') throw new Error('Google ' + j.status); // REQUEST_DENIED / OVER_QUERY_LIMIT: para e não grava nada errado
  const x = j.results[0];
  if (x.partial_match || !['ROOFTOP', 'RANGE_INTERPOLATED'].includes(x.geometry?.location_type)) return null;
  return { lat: x.geometry.location.lat, lng: x.geometry.location.lng, fonte: 'google' };
}

async function acharCompletoGeo(completo) {
  try {
    const g = await geocodificarGoogle(completo);
    if (g !== undefined) return g; // com a chave, o Google decide (preciso ou nada)
  } catch (e) { console.log('farmoMapa: ' + String(e.message).slice(0, 80)); }
  const p = completo.split(',').map((v) => v.trim());
  const cidade = (p[p.length - 1] || '').replace(/-([A-Z]{2})$/, ', $1');
  const rua = p[0].replace(/\s+(S\/N|SN)$/i, '').replace(/(\d+[A-Z]?)\/\d+[A-Z]?$/, '$1'); // 914/904 -> 914
  // plano B gratuito (Nominatim), só com número; sem número/aproximação: fica "sem coordenada"
  for (const q of [`${rua}, ${cidade}`, `${rua}, ${p[1] || ''}, ${cidade}`]) {
    const g = await nominatim(q).catch(() => null);
    if (g && /\d/.test(rua)) return { ...g, fonte: 'numero' };
  }
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

function lerManuais() {
  for (const c of [fileURLToPath(new URL('./farmo-coordenadas.json', import.meta.url)), join(homedir(), '.tuf-segredos', 'farmo-coordenadas.json')]) if (existsSync(c)) { try { return JSON.parse(readFileSync(c, 'utf8')); } catch { /* arquivo ruim */ } }
  return [];
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
  // coordenadas conferidas à mão no Google Maps (Guilherme, 11/10): ficam no cofre e valem acima de qualquer consulta
  const manuais = new Map(); for (const m of lerManuais()) manuais.set(sem(m.completo), m);
  let novos = 0; const paradas = [], semCoordenada = [];
  for (const p of lista) {
    const ck = p.enderecoCompleto ? `fm2|${sem(p.enderecoCompleto)}` : `fm1|${sem(p.endereco)}|${sem(p.bairro)}`;
    // coordenada antiga que não é de Google, 'numero' ou 'google' (ex.: 'rua', 'bairro') é aproximação: descartada e refeita
    if (p.enderecoCompleto && cache[ck] && !cache[ck].nf && !['google', 'numero'].includes(cache[ck].fonte)) cache[ck] = null;
    // com a chave do Google, coordenada do Nominatim ('numero') é refeita uma vez no Google
    if (p.enderecoCompleto && process.env.GOOGLE_GEOCODE_KEY && cache[ck] && cache[ck].fonte === 'numero') cache[ck] = null;
    const man = p.enderecoCompleto && manuais.get(sem(p.enderecoCompleto));
    if (man) { paradas.push({ ...p, lat: man.lat, lng: man.lng, precisao: 'manual' }); continue; }
    // sem endereço completo (só a rua) não há coordenada confiável: nada de aproximação (Guilherme, 10/10)
    if (!p.enderecoCompleto) { semCoordenada.push({ ...p, motivo: 'sem endereço completo' }); continue; }
    // "não achou" fica guardado por 24 h ({nf, em}) para não repetir consulta (e custo) a cada ciclo
    const nf = cache[ck]?.nf && Date.now() - Date.parse(cache[ck].em) < 24 * 3600e3;
    if (cache[ck] == null || (cache[ck].nf && !nf)) {
      if (novos >= limite) { semCoordenada.push({ ...p, pendente: true }); continue; }
      const r = await acharCompletoGeo(p.enderecoCompleto); novos++;
      cache[ck] = r || { nf: true, em: new Date().toISOString() };
    }
    const g = cache[ck];
    if (!g || g.nf) { semCoordenada.push({ ...p, motivo: 'endereço não localizado com precisão' }); continue; }
    paradas.push({ ...p, lat: g.lat, lng: g.lng, precisao: g.fonte });
  }
  if (novos) writeFileSync(cacheArq, JSON.stringify(cache));
  // origem: a base (a Farmoterápica fica no mesmo local da Base, segundo o Guilherme). confirmada: o Guilherme definiu em 10/10 que a Base e a Farmoterápica ficam em Rua Marcelo Müller, 434.
  const origem = base ? { endereco: base.endereco, lat: base.lat, lng: base.lng, confirmada: true } : null;
  return { origem, paradas, semCoordenada, geradoEm: new Date().toISOString() };
}
