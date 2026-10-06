// Backup diário do banco (Supabase free não tem backup): uma cópia JSON compactada por dia no OneDrive do Guilherme,
// pasta "Backups Painel", guardando os últimos 30 dias. Roda no Actions (ci.mjs); só faz algo na primeira execução de cada dia.
// Não loga conteúdo (repositório público). Nunca lê chave Pix: o banco não a contém.
import { gzipSync } from 'node:zlib';
import { SUPABASE_URL } from './supabase.mjs';

const PASTA = 'Backups Painel';
const MANTER = 30;
const TABELAS = ['painel', 'quadro_dia', 'quadro_linha', 'quadro_auditoria'];
const G = 'https://graph.microsoft.com/v1.0/me/drive/root:/';

const hojeSP = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);

async function lerTabela(t, h) {
  const out = [];
  for (let off = 0; ; off += 1000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}?select=*&order=${t === 'painel' ? 'area' : t === 'quadro_dia' ? 'dia' : 'id'}.asc&limit=1000&offset=${off}`, { headers: h });
    if (!r.ok) throw new Error(`${t} HTTP ${r.status}`);
    const lote = await r.json();
    out.push(...lote);
    if (lote.length < 1000) return out;
  }
}

export async function backupDiario(segredo, accessToken) {
  const gh = { Authorization: 'Bearer ' + accessToken };
  const nome = `painel-${hojeSP()}.json.gz`;
  const lista = await fetch(`${G}${encodeURIComponent(PASTA)}:/children?$select=name&$top=200`, { headers: gh });
  const existentes = lista.ok ? (await lista.json()).value.map((x) => x.name) : [];
  if (existentes.includes(nome)) return 'backup: de hoje já existe';

  const h = { apikey: segredo };
  if (segredo.startsWith('eyJ')) h.Authorization = 'Bearer ' + segredo;
  const dump = { geradoEm: new Date().toISOString(), tabelas: {} };
  for (const t of TABELAS) dump.tabelas[t] = await lerTabela(t, h);
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

  // retenção: apaga os mais antigos além dos últimos MANTER (o nome ordena por data)
  const todos = [...new Set([...existentes, nome])].filter((n) => /^painel-\d{4}-\d{2}-\d{2}\.json\.gz$/.test(n)).sort();
  for (const velho of todos.slice(0, Math.max(0, todos.length - MANTER))) {
    await fetch(`${G}${encodeURIComponent(PASTA)}/${encodeURIComponent(velho)}`, { method: 'DELETE', headers: gh });
  }
  return `backup: ${nome} (${Math.round(buf.length / 1024)} KB; ${TABELAS.map((t) => t + '=' + dump.tabelas[t].length).join(', ')})`;
}
