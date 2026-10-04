// Roda no GitHub Actions (pasta gerador/ do repositório): abre o cofre, gera os dados
// e monta a pasta _site/ que o fluxo publica no Pages. Nunca imprime segredo: os logs
// de repositório público são públicos.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cifrar, decifrar } from './cofre.mjs';

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
// cache das coordenadas das lojas (mapa): cifrado no repositório, aberto só durante a execução
const GEO = join(RAIZ, 'geocache.enc'), GEO_JSON = join(AQUI, 'geocache.json');
const geoAntes = existsSync(GEO) ? JSON.stringify(decifrar(readFileSync(GEO, 'utf8'), CHAVE)) : '{}';
writeFileSync(GEO_JSON, geoAntes);

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

const geoDepois = existsSync(GEO_JSON) ? readFileSync(GEO_JSON, 'utf8') : '{}';
if (geoDepois !== geoAntes) { writeFileSync(GEO, cifrar(JSON.parse(geoDepois), CHAVE)); console.log('cofre: coordenadas novas guardadas'); }

const enc = join(AQUI, 'publicar', 'dados.enc.json');
if (!existsSync(enc)) throw new Error('dados.enc.json não foi gerado');
const SITE = join(RAIZ, '_site');
mkdirSync(SITE, { recursive: true });
copyFileSync(join(RAIZ, 'index.html'), join(SITE, 'index.html'));
copyFileSync(enc, join(SITE, 'dados.enc.json'));
console.log('site pronto em _site/');
