// Lê o histórico bruto do Assistente Farmoterapica (só leitura), refaz as contas dos
// blocos do painel para cada período (ano / mês / semana) e grava dados.js / dados.json.
// Uso: node atualizar-dados.mjs            (gera)
//      node atualizar-dados.mjs --conferir (gera e compara o período da planilha com a aba Analise)
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createHash, randomBytes, pbkdf2Sync, createCipheriv } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { operacao as calcOperacao, planejamento as calcPlanejamento } from './operacao.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
// no GitHub Actions o ci.mjs aponta para uma cópia temporária do token
const TOKEN_FILE = process.env.TUF_TOKEN_FILE || join(homedir(), '.claude', 'excel', 'ms_graph_token.json');
const TENANT = '02670113-3dae-4a0a-8126-b9aca8ccf481';
const CLIENT = 'eb414536-78be-458a-8d66-ae7d2be31de7';
const FARMO = '01ULVECMUZCJO7HE75ONDZSEFUOJV6BLY3';
const BLOCO = 3000;

async function token() {
  const salvo = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
  // reaproveita o access token enquanto ele valer: evita renovar a cada execução agendada
  try {
    const { exp } = JSON.parse(Buffer.from(salvo.access_token.split('.')[1], 'base64url').toString());
    if (exp - Date.now() / 1000 > 300) return salvo.access_token;
  } catch { /* token ilegível: renova */ }
  const r = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT,
      refresh_token: salvo.refresh_token,
      scope: 'https://graph.microsoft.com/Files.ReadWrite offline_access',
    }),
  });
  const texto = await r.text();
  const novo = JSON.parse(texto);
  if (!novo.access_token) throw new Error('renovação do token falhou: ' + texto.slice(0, 300));
  // o refresh token é rotativo: grava o novo por cima, de forma atômica
  writeFileSync(TOKEN_FILE + '.tmp', texto);
  renameSync(TOKEN_FILE + '.tmp', TOKEN_FILE);
  return novo.access_token;
}

const base = `https://graph.microsoft.com/v1.0/me/drive/items/${FARMO}/workbook/worksheets`;
// Uma sessão sem gravação para todas as leituras de uma execução: sem ela cada chamada
// reabre e recalcula a planilha, e desde 03/10 isso estoura o tempo (HTTP 504).
let sessao = null;
async function graph(tk, caminho) {
  for (let tentativa = 1; ; tentativa++) {
    const headers = { Authorization: 'Bearer ' + tk };
    if (sessao) headers['workbook-session-id'] = sessao;
    const r = await fetch(base + caminho, { headers });
    if (r.ok) return r.json();
    const corpo = (await r.text()).slice(0, 200);
    if (![429, 502, 503, 504].includes(r.status) || tentativa === 3) throw new Error(`${caminho}: HTTP ${r.status} ${corpo}`);
    await new Promise((ok) => setTimeout(ok, tentativa * 10000));
  }
}
async function abrirSessao(tk) {
  const r = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${FARMO}/workbook/createSession`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' },
    body: JSON.stringify({ persistChanges: false }),
  });
  if (r.ok) sessao = (await r.json()).id;
}
async function fecharSessao(tk) {
  if (!sessao) return;
  await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${FARMO}/workbook/closeSession`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + tk, 'workbook-session-id': sessao },
  }).catch(() => {});
  sessao = null;
}
const faixa = async (tk, aba, end) =>
  (await graph(tk, `('${encodeURIComponent(aba)}')/range(address='${end}')?$select=values`)).values;
const ultimaLinha = async (tk, aba) =>
  (await graph(tk, `('${encodeURIComponent(aba)}')/usedRange(valuesOnly=true)?$select=rowCount`)).rowCount;

const num = (v) => (typeof v === 'number' ? v : 0);
const txt = (v) => (v == null ? '' : String(v));
// serial do Excel -> {a, m, d}
const dataDe = (serial) => {
  if (typeof serial !== 'number') return null;
  const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
  return { a: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
};
// mesma regra da planilha: semana do mês por dia corrido (1–7 = 1 … 29–31 = 5)
const semanaDe = (d) => Math.floor((d - 1) / 7) + 1;
const itensDe = (s) => s.split('/').length; // nº de "/" + 1
const ocorrencias = (s, alvo) => s.split(alvo).length - 1;
const noPeriodo = (dt, p) => dt && dt.a === p.ano && (p.mes === 0 || dt.m === p.mes) && (p.semana === 0 || semanaDe(dt.d) === p.semana);
const regiaoDe = (rota) => txt(rota).toUpperCase().replace(/^(MANHA|MANHÃ|TARDE|NOITE) - /, '');

// ---------- leitura ----------
const tk = await token();

// --se-mudou: só refaz a leitura pesada se a planilha foi salva desde a última vez
// (ou se virou o dia, porque Devoluções depende da data de hoje)
const ESTADO = join(AQUI, '.estado.json');
const hoje = new Date().toLocaleDateString('sv');
// arquivos locais que também mudam o resultado: se forem editados, regera
const locais = ['fixos.json', 'senha.txt'].map((f) => { try { return statSync(join(AQUI, f)).mtimeMs; } catch { return 0; } }).join('|');
const item = await (await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${FARMO}?$select=lastModifiedDateTime`,
  { headers: { Authorization: 'Bearer ' + tk } })).json();
if (!item.lastModifiedDateTime) throw new Error('não consegui ler a data de modificação: ' + JSON.stringify(item).slice(0, 200));
// o Acompanhamento (abas RH e Analise da Operação) também muda o resultado
const ACOMP = '01ULVECMR63GWHJZCDIBD3SOL3KXGEF6UI'; // Projeto Acompanhamento Operação
const NOVA_OP = '01ULVECMUQHBEW56F6R5GZBZY2PSAQLSER'; // PROJETO Nova Operação
const itemAcomp = await (await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${ACOMP}?$select=lastModifiedDateTime`,
  { headers: { Authorization: 'Bearer ' + tk } })).json().catch(() => ({}));
// a Operação vem do Nova Operação, editado ao vivo o dia todo
const itemNovaOp = await (await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${NOVA_OP}?$select=lastModifiedDateTime`,
  { headers: { Authorization: 'Bearer ' + tk } })).json().catch(() => ({}));
const modificado = [item, itemAcomp, itemNovaOp].map((x) => x.lastModifiedDateTime || '').join('|');
let pular = false;
if (process.argv.includes('--se-mudou')) {
  try {
    const e = JSON.parse(readFileSync(ESTADO, 'utf8'));
    pular = e.modificado === modificado && e.dia === hoje && e.locais === locais;
    // a planilha é editada o dia todo: no máximo uma leitura pesada a cada 5 minutos
    if (!pular && Date.now() - (e.geradoEmMs || 0) < 5 * 60000) pular = true;
    // "em serviço", "a entrar" e horas em aberto mudam com o relógio: regera a cada 15 min mesmo sem edição
    if (pular && Date.now() - (e.geradoEmMs || 0) >= 15 * 60000) pular = false;
  } catch { /* sem estado anterior: gera */ }
}
// sem process.exit: encerrar à força logo após um fetch derruba o Node no Windows
if (!pular) {
  try {
    await abrirSessao(tk);
    await gerar();
  } catch (e) {
    // registra uma linha só e segue: a página pendente ainda pode ser publicada
    console.log(`FALHA ao gerar ${new Date().toISOString()}: ${String(e.message).slice(0, 200)}`);
  } finally {
    await fecharSessao(tk);
  }
}
// no GitHub Actions quem publica é o próprio fluxo (ci.mjs + deploy do Pages)
if (!process.env.TUF_NAO_PUBLICAR) publicar();

// Envia página + dados cifrados ao GitHub Pages. Roda em toda execução (mesmo quando
// não regerou), para mandar o que ficou pendente; no máximo um envio a cada 6 min,
// porque o Pages aceita cerca de 10 publicações por hora.
function publicar() {
  const REPO = join(homedir(), 'acompanhamento-publicar');
  const enc = join(AQUI, 'publicar', 'dados.enc.json');
  if (!existsSync(join(REPO, '.git')) || !existsSync(enc)) return;
  const ESTADO_PUB = join(REPO, '..', '.acompanhamento-publicado.json');
  const hash = createHash('sha256').update(readFileSync(enc)).update(readFileSync(join(AQUI, 'index.html'))).digest('hex');
  let ant = {};
  try { ant = JSON.parse(readFileSync(ESTADO_PUB, 'utf8')); } catch { /* primeira vez */ }
  if (ant.hash === hash || Date.now() - (ant.quando || 0) < 6 * 60000) return;
  const git = (...a) => execFileSync('git', a, {
    cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' },
  });
  try {
    copyFileSync(enc, join(REPO, 'dados.enc.json'));
    copyFileSync(join(AQUI, 'index.html'), join(REPO, 'index.html'));
    git('add', '-A');
    if (git('status', '--porcelain').trim()) {
      git('-c', 'user.name=GuilhermeDias001', '-c', 'user.email=GuilhermeDias001@users.noreply.github.com',
        'commit', '-q', '-m', 'Atualiza dados ' + new Date().toISOString().slice(0, 16));
    }
    git('push', '-q', 'origin', 'main');
    writeFileSync(ESTADO_PUB, JSON.stringify({ hash, quando: Date.now() }));
    console.log('publicado no GitHub ' + new Date().toISOString());
  } catch (e) {
    // falha de envio não derruba a geração local; tenta de novo na próxima execução
    console.log('FALHA ao publicar: ' + String(e.stderr || e.message).trim().slice(0, 300));
  }
}

async function gerar() {
const fim = await ultimaLinha(tk, 'Historico');
// leituras em sequência, dentro da mesma sessão: em paralelo a planilha não aguenta
const sel = await faixa(tk, 'Dash', 'C8:C10');
const devol = await faixa(tk, 'Analise', 'I16:J45');
const multiHist = await faixa(tk, 'Historico', `T2:X${fim}`);
const multiAba = await faixa(tk, 'Bolsa Multi', 'A2:E600');
const analise = await faixa(tk, 'Analise', 'A1:U90');
const blocos = [];
for (let i = 2; i <= fim; i += BLOCO) {
  // A..J traz endereço (C) e bairro (E) do paciente: são descartados logo abaixo e não vão para o arquivo
  blocos.push(await faixa(tk, 'Historico', `A${i}:J${Math.min(i + BLOCO - 1, fim)}`));
}

const linhas = blocos.flat()
  .map((l) => ({ dt: dataDe(l[0]), g: txt(l[6]), h: txt(l[7]), i: txt(l[8]), j: l[9] }))
  .filter((l) => l.dt);
const multi = [
  ...multiHist.map((l) => ({ dt: dataDe(l[0]), tabela: l[1], total: l[3], adicional: l[4] })),
  ...multiAba.map((l) => ({ dt: dataDe(l[0]), tabela: l[1], total: l[3], adicional: l[4] })),
].filter((l) => l.dt);

// ---------- regras (espelham as fórmulas da aba Analise) ----------
function calcular(p) {
  const doPeriodo = linhas.filter((l) => noPeriodo(l.dt, p));

  // total de entregas: itens da coluna BOLSA, sem exigir portador
  const entregas = doPeriodo.reduce((s, l) => s + (l.h !== '' ? itensDe(l.h) : 0), 0);

  // motoristas: conta itens, nome e bolsa com TRIM
  const porMot = new Map();
  for (const l of doPeriodo) {
    const nome = l.g.trim();
    if (nome === '' || l.h.trim() === '') continue;
    porMot.set(nome, (porMot.get(nome) || 0) + itensDe(l.h));
  }
  const motoristas = [...porMot].map(([nome, qtd]) => ({ nome, qtd }))
    .sort((a, b) => b.qtd - a.qtd || a.nome.localeCompare(b.nome));

  // bolsas e termômetros
  const cont = { A: 0, B: 0, C: 0, isopor: 0, term: 0 };
  for (const l of doPeriodo) {
    const h = l.h.toUpperCase();
    const inicio = h.trim().charAt(0);
    for (const L of ['A', 'B', 'C']) cont[L] += (inicio === L ? 1 : 0) + ocorrencias(h, '/' + L);
    cont.isopor += ocorrencias(h, 'ISOPOR');
    if (l.i !== '') cont.term += itensDe(l.i);
  }
  const bolsas = [
    { nome: 'Bolsa A', qtd: cont.A }, { nome: 'Bolsa B', qtd: cont.B }, { nome: 'Bolsa C', qtd: cont.C },
    { nome: 'Isopor', qtd: cont.isopor }, { nome: 'Termômetro', qtd: cont.term },
  ];

  // regiões: conta linhas (entregas), portador sem TRIM, corte de 5% por região, até 18 colunas
  const totReg = new Map(), totMot = new Map(), cruz = new Map();
  for (const l of doPeriodo) {
    if (l.h === '') continue;
    const r = regiaoDe(l.j);
    if (r === '') continue;
    totReg.set(r, (totReg.get(r) || 0) + 1);
    if (l.g === '') continue;
    totMot.set(l.g, (totMot.get(l.g) || 0) + 1);
    const k = r + '\u0000' + l.g;
    cruz.set(k, (cruz.get(k) || 0) + 1);
  }
  const qtd = (r, m) => cruz.get(r + '\u0000' + m) || 0;
  const passa = (r, m) => qtd(r, m) >= 0.05 * totReg.get(r);
  const regs = [...totReg.keys()].sort((a, b) => totReg.get(b) - totReg.get(a));
  const cols = [...totMot.keys()]
    .filter((m) => regs.some((r) => qtd(r, m) > 0 && passa(r, m)))
    .sort((a, b) => totMot.get(b) - totMot.get(a))
    .slice(0, 18);
  const regioes = {
    motoristas: [...cols, 'OUTROS'],
    linhas: regs.map((r) => {
      const valores = cols.map((m) => (passa(r, m) ? qtd(r, m) : 0));
      const total = totReg.get(r);
      return { regiao: r, valores: [...valores, total - valores.reduce((s, v) => s + v, 0)], total };
    }),
  };

  // bolsa multi: duas fontes somadas
  const m = multi.filter((l) => noPeriodo(l.dt, p));
  const cheio = (v) => v !== '' && v != null;
  const bolsaMulti = {
    entregas: m.filter((l) => cheio(l.tabela)).length,
    adicional: m.reduce((s, l) => s + num(l.adicional), 0),
    tabela: m.reduce((s, l) => s + num(l.tabela), 0),
    total: m.reduce((s, l) => s + num(l.total), 0),
  };

  return { entregas, motoristas, regioes, bolsas, bolsaMulti };
}

// ---------- todos os períodos ----------
const chave = (p) => `${p.ano}-${p.mes}-${p.semana}`;
const anos = [...new Set(linhas.map((l) => l.dt.a))].sort();
const mesesDe = (ano) => [...new Set(linhas.filter((l) => l.dt.a === ano).map((l) => l.dt.m))].sort((a, b) => a - b);
const periodos = {};
const entregasMes = {};
const NOMES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
for (const ano of anos) {
  entregasMes[ano] = [];
  for (const mes of [0, ...mesesDe(ano)]) {
    for (const semana of [0, 1, 2, 3, 4, 5]) {
      const p = { ano, mes, semana };
      periodos[chave(p)] = calcular(p);
    }
    if (mes) entregasMes[ano].push({ mes: NOMES[mes - 1], numero: mes, qtd: periodos[chave({ ano, mes, semana: 0 })].entregas });
  }
}

// período selecionado na planilha vira o padrão da página
const selMes = typeof sel[1][0] === 'number' ? sel[1][0] : 0;
const selSem = Number(txt(sel[2][0]).slice(-1)) || 0;
let padrao = { ano: Number(sel[0][0]), mes: selMes, semana: selSem };
if (!periodos[chave(padrao)]) {
  const ano = anos[anos.length - 1];
  padrao = { ano, mes: mesesDe(ano).pop(), semana: 0 };
}

const preenchida = (l) => l[0] !== '' && l[0] != null;
const dados = {
  geradoEm: new Date().toISOString(),
  ultimoRegistro: (() => { const u = linhas[linhas.length - 1].dt; return `${u.a}-${String(u.m).padStart(2, '0')}-${String(u.d).padStart(2, '0')}`; })(),
  padrao,
  anos: anos.map((ano) => ({ ano, meses: mesesDe(ano) })),
  entregasMes,
  // não depende do período: é a situação de hoje, calculada pela própria planilha
  devolucoes: devol.filter((l) => preenchida(l) && typeof l[1] === 'number').map((l) => ({ portador: l[0], dias: l[1] })),
  periodos,
};
// dados que não vêm da planilha (escala do mês, avisos): ficam fora do index.html para
// não irem a público sem criptografia
dados.cadastroMotoristas = await cadastroMotoristas(tk);
// falha no cadastro do RH não derruba o resto do painel
try { dados.cadastroRH = await cadastroRH(tk); } catch (e) { console.log(`FALHA cadastro RH: ${String(e.message).slice(0, 200)}`); }
try {
  const ent = await entradaOperacao(tk);
  dados.operacao = calcOperacao(ent);
  dados.planejamento = calcPlanejamento(ent, dados.operacao);
} catch (e) { console.log(`FALHA operação: ${String(e.message).slice(0, 200)}`); }
if (existsSync(join(AQUI, 'fixos.json'))) dados.fixos = JSON.parse(readFileSync(join(AQUI, 'fixos.json'), 'utf8'));

const json = JSON.stringify(dados);
writeFileSync(join(AQUI, 'dados.json'), json);
writeFileSync(join(AQUI, 'dados.js'), 'window.DADOS = ' + json + ';\n');

// versão criptografada para publicar: só existe se houver senha.txt na pasta
const SENHA = join(AQUI, 'senha.txt');
if (existsSync(SENHA)) {
  const senha = readFileSync(SENHA, 'utf8').trim();
  if (senha.length < 12) throw new Error('senha.txt precisa ter pelo menos 12 caracteres');
  // o sal fica fixo enquanto a senha não muda, para a página poder guardar a chave derivada
  const SAL = join(AQUI, '.sal.json');
  const marca = createHash('sha256').update(senha).digest('hex').slice(0, 16);
  let sal = existsSync(SAL) ? JSON.parse(readFileSync(SAL, 'utf8')) : null;
  if (!sal || sal.marca !== marca) { sal = { marca, salt: randomBytes(16).toString('base64') }; writeFileSync(SAL, JSON.stringify(sal)); }
  const ITER = 600000;
  const chaveAes = pbkdf2Sync(senha, Buffer.from(sal.salt, 'base64'), ITER, 32, 'sha256');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', chaveAes, iv);
  const ct = Buffer.concat([c.update(json, 'utf8'), c.final(), c.getAuthTag()]); // texto cifrado + etiqueta, como o WebCrypto espera
  mkdirSync(join(AQUI, 'publicar'), { recursive: true });
  writeFileSync(join(AQUI, 'publicar', 'dados.enc.json'), JSON.stringify({
    v: 1, kdf: 'PBKDF2-SHA256', iter: ITER, salt: sal.salt, iv: iv.toString('base64'), ct: ct.toString('base64'),
  }));
}
writeFileSync(ESTADO, JSON.stringify({ modificado, dia: hoje, locais, geradoEmMs: Date.now() }));
console.log(`ok ${dados.geradoEm} | ${linhas.length} linhas até ${dados.ultimoRegistro} | ${Object.keys(periodos).length} períodos | ${(json.length / 1024).toFixed(0)} KB | padrão ${chave(padrao)}`);

// ---------- conferência contra a aba Analise ----------
if (process.argv.includes('--conferir')) {
  const c = periodos[chave(padrao)];
  const erros = [];
  const cmp = (nome, meu, planilha) => { if (JSON.stringify(meu) !== JSON.stringify(planilha)) erros.push(`${nome}\n   gerador:  ${JSON.stringify(meu).slice(0, 300)}\n   planilha: ${JSON.stringify(planilha).slice(0, 300)}`); };
  const col = (l0, l1, c0, c1) => analise.slice(l0 - 1, l1).map((l) => l.slice(c0, c1));
  const ate = (ls) => { const i = ls.findIndex((l) => !preenchida(l)); return i === -1 ? ls : ls.slice(0, i); };

  cmp('motoristas', c.motoristas.map((x) => [x.nome, x.qtd]), ate(col(2, 60, 0, 2)));
  cmp('entregas por mês', entregasMes[padrao.ano].map((x) => [x.mes, x.qtd]), ate(col(2, 13, 3, 5)));
  cmp('bolsas e termômetros', c.bolsas.map((x) => x.qtd), col(50, 54, 1, 2).map((l) => l[0]));
  const r2 = (v) => Math.round(v * 100) / 100;
  cmp('bolsa multi', [c.bolsaMulti.entregas, r2(c.bolsaMulti.adicional), r2(c.bolsaMulti.tabela), r2(c.bolsaMulti.total)], col(2, 5, 7, 8).map((l) => r2(l[0])));
  const regPlan = ate(col(71, 90, 0, 21));
  cmp('regiões: colunas', c.regioes.motoristas, analise[69].slice(1, 20).filter((x) => x !== ''));
  cmp('regiões: linhas', c.regioes.linhas.map((l) => [l.regiao, ...l.valores, l.total]),
    regPlan.map((l) => [l[0], ...l.slice(1, 1 + c.regioes.motoristas.length - 1), l[19], l[20]]));
  console.log(erros.length ? `CONFERÊNCIA: ${erros.length} bloco(s) divergem\n - ` + erros.join('\n - ') : `CONFERÊNCIA: motoristas, entregas por mês, bolsas, bolsa multi e regiões de ${chave(padrao)} batem com a aba Analise`);
  if (erros.length) process.exitCode = 1;
}
}

// Cadastro da aba Motorista: nome, veículo, ativo, contrato, apelido (se existir) e chave PIX (aba Pagamento).
// Lê apenas as colunas E (nome), I (veículo) e a do apelido; CPF, CNH, placa, telefone
// e usuário ficam de fora por decisão do Guilherme (03/10).
async function cadastroMotoristas(tk) {
  const ABA = 'Motorista';
  const nomes = await faixa(tk, ABA, 'E1:E400');
  const veic = await faixa(tk, ABA, 'I1:I400');
  const E = nomes.map((l) => txt(l[0]).trim());
  const I = veic.map((l) => txt(l[0]).trim().toUpperCase());
  const iGeral = E.findIndex((v) => v.toUpperCase() === 'CADASTRO GERAL');
  // colunas opcionais achadas pelo cabeçalho, na linha 1 ou na do cabeçalho do bloco geral
  const linhasCab = [1, iGeral >= 0 ? iGeral + 2 : null].filter(Boolean);
  const cabs = [];
  for (const lc of linhasCab) cabs.push((await faixa(tk, ABA, `A${lc}:Z${lc}`))[0]);
  async function colunaPorCabecalho(titulo) {
    for (const cab of cabs) {
      const c = cab.findIndex((v) => txt(v).trim().toUpperCase() === titulo);
      if (c >= 0) {
        const letra = String.fromCharCode(65 + c);
        return (await faixa(tk, ABA, `${letra}1:${letra}400`)).map((l) => txt(l[0]).trim().toUpperCase());
      }
    }
    return null;
  }
  const A = await colunaPorCabecalho('APELIDO');
  const C = await colunaPorCabecalho('CONTRATO');
  const reg = new Map();
  const add = (i, ativo) => {
    const nome = E[i].toUpperCase();
    if (!nome) return;
    const r = reg.get(nome) || { nome, veiculo: '', ativo: false, contrato: 'FARMOTERAPICA' };
    r.ativo = r.ativo || ativo;
    if (!r.veiculo && I[i]) r.veiculo = I[i];
    if (A && A[i] && !r.apelido) r.apelido = A[i];
    if (C && C[i]) r.contrato = C[i]; // sem a coluna CONTRATO, todos são FARMOTERAPICA (decisão do Guilherme, 03/10)
    reg.set(nome, r);
  };
  const fimAtivos = iGeral >= 0 ? iGeral : E.length;
  for (let i = 1; i < fimAtivos; i++) add(i, true);            // linha 2 até antes de CADASTRO GERAL
  if (iGeral >= 0) for (let i = iGeral + 2; i < E.length; i++) add(i, false); // pula o rótulo e o cabeçalho
  // chave PIX: autorizada pelo Guilherme no chat em 03/10, inteira, só dentro do arquivo cifrado.
  // A aba Pagamento é um registro de pagamentos; vale a chave da última linha da pessoa por data.
  // Lê só A (data), E (nome) e G (chave) — nunca valor pago nem dados bancários.
  const semAcento = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
  const fimPag = await ultimaLinha(tk, 'Pagamento');
  const fimP = Math.max(fimPag, 2);
  const pd = await faixa(tk, 'Pagamento', `A2:A${fimP}`);
  const pn = await faixa(tk, 'Pagamento', `E2:E${fimP}`);
  const pk = await faixa(tk, 'Pagamento', `G2:G${fimP}`);
  const pix = new Map();
  pd.forEach((l, i) => {
    const data = typeof l[0] === 'number' ? l[0] : null;
    const nome = semAcento(txt(pn[i][0]));
    const chave = txt(pk[i][0]).trim();
    if (data == null || !nome || !chave) return;
    const atual = pix.get(nome);
    if (!atual || data >= atual.data) pix.set(nome, { data, chave });
  });
  for (const r of reg.values()) {
    const p = pix.get(semAcento(r.nome));
    if (p) r.pix = p.chave;
  }
  return [...reg.values()].sort((a, b) => (b.ativo - a.ativo) || a.nome.localeCompare(b.nome));
}

// rh.json = [A1:E1500, F1:K1500, N1:N1500, P1:T1500, AB1:AC1500] no formato do Excel
// Services ({rows: [[{v, fv}]]}), nessa ordem (o serviço recusa mais de ~10 mil células por
// pedido). Remonta as linhas na grade A:AC, com as colunas sensíveis vazias.
async function rhDoFluxo(tk) {
  const base = 'https://graph.microsoft.com/v1.0/me/drive/root:/' + encodeURI('Painel TUF - copias/rh.json');
  const meta = await (await fetch(base + '?$select=lastModifiedDateTime', { headers: { Authorization: 'Bearer ' + tk } })).json();
  if (!meta.lastModifiedDateTime) return null;
  if (Date.now() - Date.parse(meta.lastModifiedDateTime) > 6 * 3600000) { console.log('rh.json com mais de 6 h: usando a aba RH'); return null; }
  const r = await fetch(base + ':/content', { headers: { Authorization: 'Bearer ' + tk } });
  if (!r.ok) return null;
  const partes = JSON.parse(await r.text());
  const inicio = [0, 5, 13, 15, 27]; // A, F, N, P, AB
  const linhas = Array.from({ length: 1500 }, () => Array(29).fill(''));
  partes.forEach((p, k) => (p.rows || []).forEach((row, i) => row.forEach((c, j) => {
    // número/data vem em v; texto pode vir só em fv
    if (i < 1500) linhas[i][inicio[k] + j] = c.v ?? c.fv ?? '';
  })));
  return linhas;
}

// Cadastro do RH: aba RH do Acompanhamento, que espelha por vínculo a aba Ativos do
// "CADASTRO DE NOVOS FUNCIONARIOS" (mesmas colunas A:AC). E-mail, CPF, placa, celulares,
// parentesco, endereço, bairro, CEP e PIN não são vinculados (decisão do Guilherme, 03/10).
// O vínculo só renova quando alguém abre o Acompanhamento no Excel Online.

async function cadastroRH(tk) {
  const url = `https://graph.microsoft.com/v1.0/me/drive/items/${ACOMP}/workbook/worksheets('RH')/range(address='A1:AC1500')?$select=values`;
  let vals;
  for (let tentativa = 1; ; tentativa++) {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + tk } });
    if (r.ok) { vals = (await r.json()).values; break; }
    if (![429, 502, 503, 504].includes(r.status) || tentativa === 3) throw new Error(`RH: HTTP ${r.status}`);
    await new Promise((ok) => setTimeout(ok, tentativa * 10000));
  }
  // Preferência: o rh.json que o fluxo "Painel TUF - Ler RH" (Power Automate, de hora em hora)
  // grava no OneDrive. Ele pede ao Excel do RH só as faixas liberadas (A:K, N, P:T, AB:AC da
  // aba Ativos), então CPF, e-mail, telefones, endereço, placa e PIN nunca saem de lá.
  // Sem o arquivo (ou com ele velho), fica a aba RH do Acompanhamento, que só renova quando
  // alguém abre o arquivo.
  const viaFluxo = await rhDoFluxo(tk);
  if (viaFluxo) vals = viaFluxo;
  if (txt(vals[0][0]).trim().toUpperCase() !== 'NOME COMPLETO') throw new Error('aba RH sem o título NOME COMPLETO em A1 (vínculo bloqueado ou fora do lugar)');
  const data = (v) => { const d = dataDe(v); return d && v > 20000 ? `${d.a}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}` : txt(v).trim(); };
  const hora = (v) => {
    if (typeof v !== 'number' || v >= 1) return txt(v).trim();
    const min = Math.round(v * 1440);
    return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  };
  // índice da coluna na planilha do RH; tipo: d = data, h = hora
  const CAMPOS = [
    ['nome', 0], ['funcao', 1], ['integracao', 2, 'd'], ['registro', 3], ['horarioIntegracao', 4, 'h'], ['local', 5],
    ['escala', 6], ['folga', 7], ['inicio', 8, 'd'], ['exp30', 9, 'd'], ['exp90', 10, 'd'], ['modeloMoto', 13],
    ['bau', 15], ['camiseta', 16], ['tamanho', 17], ['celularTuf', 18], ['chip', 19], ['demissao', 27, 'd'], ['observacao', 28],
  ];
  const lista = [];
  for (const l of vals.slice(1)) {
    if (!txt(l[0]).trim()) continue;
    const o = {};
    for (const [k, i, t] of CAMPOS) o[k] = t === 'd' ? data(l[i]) : t === 'h' ? hora(l[i]) : txt(l[i]).trim();
    o.situacao = 'ATIVO';
    lista.push(o);
  }
  return lista;
}

async function lerAcomp(tk, aba, end, item = ACOMP) {
  // item = id do arquivo, ou caminho no OneDrive ("root:/pasta/arquivo.xlsx")
  const arq = item.startsWith('root:') ? encodeURI(item) + ':' : `items/${item}`;
  const url = `https://graph.microsoft.com/v1.0/me/drive/${arq}/workbook/worksheets('${encodeURIComponent(aba)}')/range(address='${end}')?$select=values`;
  for (let tentativa = 1; ; tentativa++) {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + tk } });
    if (r.ok) return (await r.json()).values;
    if (![429, 502, 503, 504].includes(r.status) || tentativa === 3) throw new Error(`${aba}!${end}: HTTP ${r.status}`);
    await new Promise((ok) => setTimeout(ok, tentativa * 10000));
  }
}

// Aba dd-mm-aaaa de amanhã no Nova Operação, já no formato das linhas da DIA ATUAL. A DIA
// ATUAL acha cada coluna da aba do dia pelo título da linha 1 (DIA ATUAL!A200:R200); aqui
// faz o mesmo. A coluna Chave Pix nunca é lida. Devolve null se a aba ainda não existe.
async function abaDeAmanha(ler) {
  const d = new Date(Date.now() - 3 * 3600000 + 86400000); // amanhã em São Paulo
  const nome = `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;
  let cab;
  try { cab = (await ler(nome, 'A1:Z1'))[0]; } catch { return null; }
  const col = (titulo) => cab.findIndex((h) => txt(h).trim().toUpperCase() === titulo.toUpperCase());
  const iPix = col('Chave Pix');
  const letra = (i) => String.fromCharCode(65 + i);
  // duas leituras, uma de cada lado da coluna Pix (ou uma só, se ela não existir)
  const partes = iPix < 0 ? [[0, 25]] : [[0, iPix - 1], [iPix + 1, 25]].filter(([a, b]) => a <= b);
  const linhas = Array.from({ length: 198 }, () => []);
  for (const [a, b] of partes) {
    const v = await ler(nome, `${letra(a)}2:${letra(b)}199`);
    v.forEach((l, r) => l.forEach((x, j) => { linhas[r][a + j] = x; }));
  }
  const mapa = { B: 'Horário', D: 'Loja', E: 'CHEGADA', H: 'Valor', I: 'Colaborador/Reposição', J: 'STATUS',
    K: 'TEMPO INÍCIO', L: 'Tipo', M: 'Motivo', N: 'TEMPO FINAL', Q: 'FALTANTE', R: 'OBSERVAÇÃO' };
  const idx = Object.fromEntries(Object.entries(mapa).map(([k, t]) => [k, col(t)]));
  return linhas.map((l) => Object.fromEntries(Object.entries(idx).map(([k, i]) => [k, i < 0 ? '' : l[i] ?? ''])));
}

// Área Operação e Planejamento: calculadas direto do Nova Operação (operacao.mjs), sem
// depender de alguém abrir o Acompanhamento. Do Acompanhamento só saem as metas, que são
// valores digitados (Analise!K69:K70 e F156), não vínculos.
async function entradaOperacao(tk) {
  const ler = (aba, end) => lerAcomp(tk, aba, end, NOVA_OP);
  // DIA ATUAL sem a coluna G (Chave Pix): A:F e H:R
  const af = await ler('DIA ATUAL', 'A2:F199');
  const hr = await ler('DIA ATUAL', 'H2:R199');
  const dia = af.map((l, i) => {
    const o = { B: l[1], D: l[3], E: l[4] };
    'HIJKLMNOPQR'.split('').forEach((c, j) => { o[c] = hr[i][j]; });
    return o;
  });
  const cabContratos = (await ler('Contratos', 'A1:M1'))[0];
  const contratos = await ler('Contratos', 'A501:M1098');
  const cadastro = await ler('Cadastro Colaboradores', 'B1:C1500');
  const k = await lerAcomp(tk, 'Analise', 'K69:K70');
  const f = await lerAcomp(tk, 'Analise', 'F156');
  const n = (v, padrao) => (typeof v === 'number' ? v : padrao);
  // Portaria: cópia que o fluxo "Painel TUF - Copiar Portaria" (Power Automate, a cada 15 min)
  // traz do site TUFLogstica, que o Graph não lê. Sem a cópia, a página só não mostra o bloco.
  let portaria = null;
  try {
    const PORT = 'root:/Painel TUF - copias/CONTROLE DE ATENDIMENTOS - PORTARIA.xlsx';
    portaria = { ag: await lerAcomp(tk, 'ATENDIMENTOS', 'A2:G5000', PORT), saida: await lerAcomp(tk, 'ATENDIMENTOS', 'J2:J5000', PORT) };
  } catch (e) { console.log(`FALHA portaria: ${String(e.message).slice(0, 150)}`); }
  return {
    dia, dataRef: dia[0].P, cabContratos, contratos, cadastro, portaria, diaAmanha: await abaDeAmanha(ler),
    metas: { prestador: n(k[0][0], 170), mei: n(k[1][0], 200), reposicaoH: n(f[0][0], 2) },
  };
}
