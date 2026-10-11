// Roda no GitHub Actions (pasta gerador/ do repositório): abre o cofre, gera os dados
// e monta a pasta _site/ que o fluxo publica no Pages. Nunca imprime segredo: os logs
// de repositório público são públicos.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cifrar, decifrar } from './cofre.mjs';
import { gravarSupabase, semearQuadro } from './supabase.mjs';
import { backupDiario } from './backup.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..');
const COFRE = join(RAIZ, 'segredos.enc');
const CHAVE = process.env.CHAVE_CI;
const s = decifrar(readFileSync(COFRE, 'utf8'), CHAVE);
// o Actions passa a esconder esses valores se algum dia aparecerem no log
for (const v of [s.token.refresh_token, s.token.access_token, s.senha]) if (v) console.log(`::add-mask::${v}`);

const TOKEN = join(process.env.RUNNER_TEMP || AQUI, 'ms.json');
writeFileSync(TOKEN, JSON.stringify(s.token));
writeFileSync(join(AQUI, 'senha.txt'), s.senha);
writeFileSync(join(AQUI, '.sal.json'), JSON.stringify(s.sal));
if (s.fixos) writeFileSync(join(AQUI, 'fixos.json'), JSON.stringify(s.fixos));
if (s.extras) writeFileSync(join(AQUI, 'lojas-extra.json'), JSON.stringify(s.extras));
// cache das coordenadas das lojas (mapa): cifrado no repositório, aberto só durante a execução
// caches cifrados no repositório, abertos só durante a execução: coordenadas das lojas e histórico do quadro
const CACHES = [['geocache.enc', 'geocache.json', 'coordenadas'], ['historico-quadro.enc', 'historico-quadro.json', 'histórico do quadro']]
  .map(([enc, json, nome]) => ({ enc: join(RAIZ, enc), json: join(AQUI, json), nome }));
for (const c of CACHES) { c.antes = existsSync(c.enc) ? JSON.stringify(decifrar(readFileSync(c.enc, 'utf8'), CHAVE)) : '{}'; writeFileSync(c.json, c.antes); }

try {
  execFileSync(process.execPath, [join(AQUI, 'atualizar-dados.mjs')], {
    cwd: AQUI, stdio: 'inherit', env: { ...process.env, TUF_TOKEN_FILE: TOKEN, TUF_NAO_PUBLICAR: '1' },
  });
} finally {
  // o token Microsoft se renova a cada uso: guarda o novo no cofre (o antigo segue válido até vencer)
  const novo = JSON.parse(readFileSync(TOKEN, 'utf8'));
  if (novo.refresh_token && novo.refresh_token !== s.token.refresh_token) {
    writeFileSync(COFRE, cifrar({ ...s, token: novo }, CHAVE));
    console.log('cofre: token renovado');
  }
}

for (const c of CACHES) {
  const depois = existsSync(c.json) ? readFileSync(c.json, 'utf8') : '{}';
  if (depois !== c.antes) { writeFileSync(c.enc, cifrar(JSON.parse(depois), CHAVE)); console.log(`cofre: ${c.nome} atualizado`); }
}

// Supabase (Fase 3): só grava se o segredo SUPABASE_SECRET existir; falha aqui não derruba o site
if (process.env.SUPABASE_SECRET) {
  try {
    console.log(await gravarSupabase(JSON.parse(readFileSync(join(AQUI, 'dados.json'), 'utf8')), process.env.SUPABASE_SECRET));
  } catch (e) { console.log('FALHA Supabase: ' + String(e.message).slice(0, 200)); }
  try {
    console.log(await semearQuadro(JSON.parse(readFileSync(join(AQUI, 'dados.json'), 'utf8')), process.env.SUPABASE_SECRET));
  } catch (e) { console.log('FALHA quadro no banco: ' + String(e.message).slice(0, 200)); }
  // resultado do backup fica no banco (painel.area='backup_status'): o site pode mostrar "último backup" e alertar se parar
  const statusBackup = async (corpo) => {
    const k = process.env.SUPABASE_SECRET, hd = { apikey: k, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' };
    if (k.startsWith('eyJ')) hd.Authorization = 'Bearer ' + k;
    await fetch('https://jetujppwmyzyfkaflplj.supabase.co/rest/v1/painel?on_conflict=area', { method: 'POST', headers: hd, body: JSON.stringify([{ area: 'backup_status', dados: corpo, versao: String(Date.now()), atualizado_em: new Date().toISOString() }]) }).catch(() => {});
  };
  try {
    const msg = await backupDiario(process.env.SUPABASE_SECRET, JSON.parse(readFileSync(TOKEN, 'utf8')).access_token, CHAVE);
    console.log(msg);
    if (!msg.includes('já existe')) await statusBackup({ ok: true, em: new Date().toISOString(), resumo: msg });
  } catch (e) {
    console.log('FALHA backup: ' + String(e.message).slice(0, 200));
    await statusBackup({ ok: false, em: new Date().toISOString(), erro: String(e.message).slice(0, 200) });
  }
}
// Site antigo (GitHub Pages) DESATIVADO (auditoria 11/10, M4/F-07): não publica mais o painel nem o dados.enc.json;
// só uma página que leva ao endereço novo (Cloudflare). O 404.html faz o mesmo para qualquer caminho antigo.
const SITE = join(RAIZ, '_site');
mkdirSync(SITE, { recursive: true });
const NOVO = 'https://painel-site.pages.dev/';
const redirecionar = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0; url=${NOVO}"><title>Painel de Controle mudou de endereço</title></head>
<body style="font:16px system-ui,sans-serif;margin:40px"><p>O Painel de Controle mudou de endereço: <a href="${NOVO}">${NOVO}</a></p>
<script>location.replace('${NOVO}'+location.hash)</script></body></html>`;
writeFileSync(join(SITE, 'index.html'), redirecionar);
writeFileSync(join(SITE, '404.html'), redirecionar);
console.log('site antigo: só redirecionamento em _site/');
