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
// Pedidos ao Nominatim só dentro da Grande SP (viewbox), do mais preciso ao menos:
// rua+número+cidade, rua+cidade, e por fim o CEP (BrasilAPI), que costuma ser o centro da
// cidade (em 04/10, 58 lojas caíram no mesmo ponto). Endereço com várias lojas ("... / LOJA 2 - ...")
// usa o primeiro.
const GRANDE_SP = '-47.2,-23.0,-45.9,-24.2';
async function nominatim(q) {
  await espera(1100); // no máximo 1 pedido por segundo e identificação obrigatória
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&viewbox=${GRANDE_SP}&bounded=1&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'painel-tuf/1.0 (github.com/GuilhermeDias001/painel-acompanhamento)' } });
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
      const r = await fetch(`https://brasilapi.com.br/api/cep/v2/${cep}`);
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
    const nome = txt(b), endereco = txt(r);
    if (!nome || !endereco || lojas.has(nome) || ehGrupo(nome)) continue;
    const tipo = tipoDe(nome);
    if (!tipo) continue;
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
    const o = { nome: l.nome, tipo: l.tipo, lat: g.lat, lng: g.lng, status, endereco: l.endereco, precisao: g.fonte };
    if (status === 'aberta' && aberto.get(chave)) o.tempo = aberto.get(chave);
    if (l.regiao) o.regiao = l.regiao;
    saida.push(o);
  }
  if (novos) writeFileSync(cacheArq, JSON.stringify(cache));
  return { lojas: saida, semCoordenada: [...lojas.values()].filter((l) => cache['v3|' + l.endereco] === null).map((l) => l.nome) };
}
