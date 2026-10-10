// Backup do banco (Supabase free não tem backup): cópia JSON compactada no OneDrive do Guilherme, pasta "Backups Painel".
// Roda no Actions (ci.mjs), a cada execução (10 min), mas só grava 1 arquivo por hora cheia de São Paulo: painel-AAAA-MM-DD-HH.json.gz.
// Retenção: tudo das últimas 48 h; antes disso, o último arquivo de cada dia, por 30 dias.
// Cobre TODAS as tabelas do schema public (descobertas pela API; vale também para tabelas novas) — antes eram só 4 e ficavam de fora Farmo, legado, fichas etc.
// Confere o tamanho no OneDrive depois de enviar e falha (erro visível no Actions) se algo não bater.
// Não loga conteúdo (repositório público). Nunca lê chave Pix: o banco não a contém.
import { gzipSync } from 'node:zlib';
import { SUPABASE_URL } from './supabase.mjs';

const PASTA = 'Backups Painel';
const DIAS = 30;
const HORAS = 48;
const G = 'https://graph.microsoft.com/v1.0/me/drive/root:/';
const NOME = /^painel-(\d{4}-\d{2}-\d{2})(?:-(\d{2}))?\.json\.gz$/;

const agoraSP = () => new Date(Date.now() - 3 * 3600e3).toISOString(); // AAAA-MM-DDTHH:...

async function tabelasDoBanco(h) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/`, { headers: { ...h, Accept: 'application/openapi+json' } });
  if (!r.ok) throw new Error('lista de tabelas HTTP ' + r.status);
  const defs = (await r.json()).definitions || {};
  return Object.entries(defs).map(([nome, d]) => ({ nome, colunas: Object.keys(d.properties || {}) }));
}

async function lerTabela({ nome, colunas }, h) {
  const ordem = colunas.includes('id') ? 'id' : colunas[0];
  const out = [];
  for (let off = 0; ; off += 1000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${nome}?select=*&order=${ordem}.asc&limit=1000&offset=${off}`, { headers: h });
    if (!r.ok) throw new Error(`${nome} HTTP ${r.status}`);
    const lote = await r.json();
    out.push(...lote);
    if (lote.length < 1000) return out;
  }
}

export async function backupDiario(segredo, accessToken) {
  const gh = { Authorization: 'Bearer ' + accessToken };
  const agora = agoraSP();
  const nome = `painel-${agora.slice(0, 10)}-${agora.slice(11, 13)}.json.gz`;
  const lista = await fetch(`${G}${encodeURIComponent(PASTA)}:/children?$select=name,size&$top=500`, { headers: gh });
  if (!lista.ok && lista.status !== 404) throw new Error('listar pasta de backup HTTP ' + lista.status);
  const existentes = lista.ok ? (await lista.json()).value : [];
  if (existentes.some((x) => x.name === nome)) return 'backup: desta hora já existe';

  const h = { apikey: segredo };
  if (segredo.startsWith('eyJ')) h.Authorization = 'Bearer ' + segredo;
  const dump = { geradoEm: new Date().toISOString(), tabelas: {} };
  const tabs = await tabelasDoBanco(h);
  for (const t of tabs) dump.tabelas[t.nome] = await lerTabela(t, h);
  const buf = gzipSync(Buffer.from(JSON.stringify(dump)));

  const url = `${G}${encodeURIComponent(PASTA)}/${encodeURIComponent(nome)}:/`;
  if (buf.length < 3.5e6) {
    const r = await fetch(url + 'content', { method: 'PUT', headers: { ...gh, 'Content-Type': 'application/gzip' }, body: buf });
    if (!r.ok) throw new Error('upload HTTP ' + r.status);
  } else {
    const s = await fetch(url + 'createUploadSession', { method: 'POST', headers: { ...gh, 'Content-Type': 'application/json' }, body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }) });
    if (!s.ok) throw new Error('sessão de upload HTTP ' + s.status);
    const r = await fetch((await s.json()).uploadUrl, { method: 'PUT', headers: { 'Content-Length': String(buf.length), 'Content-Range': `bytes 0-${buf.length - 1}/${buf.length}` }, body: buf });
    if (!r.ok) throw new Error('upload HTTP ' + r.status);
  }
  // confere: o arquivo no OneDrive tem o mesmo tamanho do que foi enviado
  const conf = await fetch(`${G}${encodeURIComponent(PASTA)}/${encodeURIComponent(nome)}?$select=size`, { headers: gh });
  const tam = conf.ok ? (await conf.json()).size : -1;
  if (tam !== buf.length) throw new Error(`backup ${nome} não conferiu: enviado ${buf.length} bytes, no OneDrive ${tam}`);

  // retenção: tudo das últimas HORAS h; antes disso só o último de cada dia, até DIAS dias
  const todos = [...new Set([...existentes.map((x) => x.name), nome])].filter((n) => NOME.test(n)).sort();
  const corte = new Date(Date.now() - 3 * 3600e3 - HORAS * 3600e3).toISOString();
  const limiteDia = new Date(Date.now() - 3 * 3600e3 - DIAS * 86400e3).toISOString().slice(0, 10);
  const ultimoDoDia = new Map();
  for (const n of todos) ultimoDoDia.set(n.match(NOME)[1], n);
  for (const n of todos) {
    const [, dia, hh] = n.match(NOME);
    const recente = `${dia}T${hh || '23'}` >= corte.slice(0, 13);
    const guardar = recente || (ultimoDoDia.get(dia) === n && dia >= limiteDia);
    if (!guardar) await fetch(`${G}${encodeURIComponent(PASTA)}/${encodeURIComponent(n)}`, { method: 'DELETE', headers: gh });
  }
  return `backup: ${nome} (${Math.round(buf.length / 1024)} KB, ${tabs.length} tabelas, ${Object.values(dump.tabelas).reduce((s, x) => s + x.length, 0)} linhas)`;
}
