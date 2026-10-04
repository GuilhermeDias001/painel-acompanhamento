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
const tipoDe = (nome) => {
  const n = semAcento(nome);
  if (n.startsWith('ESCRITORIO')) return null;
  for (const [tipo, redes] of TIPOS) if (redes.some((r) => n.startsWith(r))) return tipo;
  return null;
};
// vagas que juntam várias lojas ("82/91", "02, 12 E 14", "ORATORIO/JUVENTUS") não são um ponto
const ehGrupo = (nome) => /\//.test(nome) || /\d\s*(,|\bE\b)\s*\d/.test(semAcento(nome));

const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function geocodificar(endereco) {
  const cep = (endereco.match(/\b(\d{5})-?(\d{3})\b/) || []).slice(1).join('');
  if (cep.length === 8) {
    try {
      const r = await fetch(`https://brasilapi.com.br/api/cep/v2/${cep}`);
      if (r.ok) {
        const c = (await r.json()).location?.coordinates || {};
        if (c.latitude && c.longitude) return { lat: +c.latitude, lng: +c.longitude, fonte: 'cep' };
      }
    } catch { /* tenta o Nominatim */ }
  }
  // Nominatim: no máximo 1 pedido por segundo e identificação obrigatória
  await espera(1100);
  const q = endereco.replace(/^Endere[cç]o:\s*/i, '').replace(/,?\s*\d{5}-?\d{3}\s*$/, '');
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'painel-tuf/1.0 (github.com/GuilhermeDias001/painel-acompanhamento)' } });
  if (r.ok) {
    const j = await r.json();
    if (j[0]) return { lat: +j[0].lat, lng: +j[0].lon, fonte: 'osm' };
  }
  return null;
}

// contratos: linhas [B, R, T, U] (nome, endereço, bairro, região) da aba Contratos
export async function montarMapa({ contratos, dia, operacao, cacheArq }) {
  const cache = existsSync(cacheArq) ? JSON.parse(readFileSync(cacheArq, 'utf8')) : {};
  let novos = 0;
  const lojas = new Map();
  for (const [b, r, t, u] of contratos) {
    const nome = txt(b), endereco = txt(r);
    if (!nome || !endereco || lojas.has(nome) || ehGrupo(nome)) continue;
    const tipo = tipoDe(nome);
    if (!tipo) continue;
    lojas.set(nome, { nome, tipo, endereco, bairro: txt(t), regiao: txt(u) });
  }
  // status do dia: última linha da loja na DIA ATUAL; em aberto (com tempo) vem da Operação
  const statusDia = new Map();
  for (const l of dia) if (txt(l.D)) statusDia.set(semAcento(txt(l.D)), semAcento(txt(l.J)));
  const aberto = new Map((operacao?.lojasEmAberto || []).map((x) => [semAcento(x.loja), x.tempo]));

  const saida = [];
  for (const l of lojas.values()) {
    if (!(l.endereco in cache)) {
      if (novos >= 60) continue; // limita cada execução; o resto entra nas próximas
      cache[l.endereco] = await geocodificar(l.endereco).catch(() => null);
      novos++;
    }
    const g = cache[l.endereco];
    if (!g) continue;
    const chave = semAcento(l.nome);
    const status = aberto.has(chave) ? 'vermelho' : /PRE CONFIRMADO/.test(statusDia.get(chave) || '') ? 'amarelo' : 'verde';
    const o = { nome: l.nome, tipo: l.tipo, lat: g.lat, lng: g.lng, status, endereco: l.endereco };
    if (aberto.get(chave)) o.tempo = aberto.get(chave);
    if (l.regiao) o.regiao = l.regiao;
    saida.push(o);
  }
  if (novos) writeFileSync(cacheArq, JSON.stringify(cache));
  return { lojas: saida, semCoordenada: [...lojas.values()].filter((l) => cache[l.endereco] === null).map((l) => l.nome) };
}
