// Coordenadas das paradas da Farmoterápica para o mapa do site (pedido do ENG-A/Guilherme 10/10). Cada parada = endereço do cadastro de rotas
// (+ bairro da Operação). Geocodificação com a mesma infra do mapa das lojas (Nominatim, 1 pedido/s, cache cifrado). O traçado por estrada e o km são
// calculados no navegador. Vai só para a área logada 'farmo_mapa' do Supabase: nunca em dados.js nem dados.enc.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { nominatim, geocodificar } from './mapa.mjs';

const txt = (v) => (v == null ? '' : String(v)).trim();
const sem = (s) => txt(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ');

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
  const add = (rota, endereco) => { const k = sem(rota) + '|' + sem(endereco); if (!txt(endereco) || vistos.has(k)) return; vistos.add(k); lista.push({ rota: txt(rota), endereco: txt(endereco), bairro: bairroPor.get(sem(endereco)) || '' }); };
  for (const x of farmoOp.enderecosPorRota || []) add(x.rota, x.endereco);
  for (const l of farmoOp.operacaoHoje || []) add(l.rota, l.endereco);
  let novos = 0; const paradas = [], semCoordenada = [];
  for (const p of lista) {
    const ck = `fm1|${sem(p.endereco)}|${sem(p.bairro)}`;
    if (!(ck in cache)) { if (novos >= limite) { semCoordenada.push({ ...p, pendente: true }); continue; } cache[ck] = await achar(p.endereco, p.bairro); novos++; }
    const g = cache[ck];
    if (!g) { semCoordenada.push(p); continue; }
    paradas.push({ ...p, lat: g.lat, lng: g.lng, precisao: g.fonte });
  }
  if (novos) writeFileSync(cacheArq, JSON.stringify(cache));
  // origem: a base (a Farmoterápica fica no mesmo local da Base, segundo o Guilherme). confirmada: o Guilherme definiu em 10/10 que a Base e a Farmoterápica ficam em Rua Marcelo Müller, 434.
  const origem = base ? { endereco: base.endereco, lat: base.lat, lng: base.lng, confirmada: true } : null;
  return { origem, paradas, semCoordenada, geradoEm: new Date().toISOString() };
}
