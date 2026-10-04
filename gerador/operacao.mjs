// Operação calculada direto do PROJETO Nova Operação (aba DIA ATUAL, Contratos e
// Cadastro Colaboradores), sem passar pela aba Analise do Acompanhamento — que só
// recalcula quando alguém abre o arquivo. Cada bloco reproduz a fórmula da Analise
// indicada no comentário (mapeada em 04/10).
//
// Função pura: recebe as faixas já lidas e devolve DADOS.operacao.

// Brasil sem horário de verão desde 2019: São Paulo = UTC-3 o ano todo
export const serialSP = (ms = Date.now()) => (ms - 3 * 3600000) / 86400000 + 25569;

const txt = (v) => (v == null ? '' : String(v));
const num = (v) => (typeof v === 'number' ? v : 0);
// UPPER + tira acento + TRIM + espaços duplos, como o SUBSTITUTE encadeado das fórmulas
const norm = (s) => txt(s).toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim().replace(/ {2,}/g, ' ');
const igual = (a, b) => txt(a).toUpperCase() === txt(b).toUpperCase(); // "=" do Excel ignora maiúscula
const dataSerial = (d, m, a) => {
  const t = Date.UTC(a, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== a || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null; // DATEVALUE recusa 31/02
  return t / 86400000 + 25569;
};
// "dd/mm/aaaa" ou "dd/mm" (com o ano da data de referência), na posição exata ou na primeira que achar
const lerData10 = (s) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s); return m ? dataSerial(+m[1], +m[2], +m[3]) : null; };
const lerData5 = (s, ano) => { const m = /^(\d{2})\/(\d{2})/.exec(s); return m ? dataSerial(+m[1], +m[2], ano) : null; };
const anoDe = (serial) => new Date((serial - 25569) * 86400000).getUTCFullYear();
const ddmm = (serial) => { const d = new Date((serial - 25569) * 86400000); return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
const hm = (h) => { const m = Math.round(h * 60); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
// h:mm do Excel trunca os segundos (o A203 da Analise, ao contrário, arredonda: usa ROUND)
const hmTrunc = (h) => { const m = Math.floor(h * 60 + 1e-9); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
const DIAS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

// Disponíveis (Analise!AB105:AJ702, E105:E110 e A106#). `ref` = data/hora de referência
// (serial do Excel): agora na Operação; amanhã 12:00 no Planejamento.
export function escala({ contratos, cabContratos, cadastro, dia }, ref) {
  const status = new Map();
  for (const [nome, st] of cadastro) { const k = txt(nome).toUpperCase(); if (k && !status.has(k)) status.set(k, txt(st)); }
  const faltantes = new Set(dia.map((l) => norm(l.Q)).filter(Boolean));
  const emLoja = new Set(dia.map((l) => norm(l.I)).filter(Boolean));
  const motivoDe = new Map();
  for (const l of dia) { const k = norm(l.I); if (k && !motivoDe.has(k)) motivoDe.set(k, l.M); }

  const dt = new Date((Math.floor(ref) - 25569) * 86400000);
  const dNome = DIAS[dt.getUTCDay()];
  const n = Math.min(Math.floor((dt.getUTCDate() - 1) / 7) + 1, 4);
  const iCol = dNome === 'Domingo' ? 8 + n : cabContratos.findIndex((h) => txt(h).trim() === dNome);
  const agMin = Math.round((ref - Math.floor(ref)) * 1440);
  const minutos = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s); return m ? +m[1] * 60 + +m[2] : -1; };

  const lista = [];
  for (const l of contratos) {
    const nome = txt(l[0]);
    if (!nome) continue;
    const contrato = txt(l[2]); // AC = Contratos!C (TIPO)
    if (!igual(contrato, 'ELITE') && !igual(contrato, 'BASE')) continue;
    const st = status.has(nome.toUpperCase()) ? status.get(nome.toUpperCase()) : 'Ativo'; // AD: XLOOKUP, padrão "Ativo"
    if (!igual(st, 'Ativo')) continue;
    const h = iCol >= 3 && txt(l[iCol]) !== '' ? txt(l[iCol]) : 'SEM ESCALA DEFINIDA'; // AF
    const chave = norm(nome);
    const m = norm(motivoDe.get(chave));
    const falta = faltantes.has(chave) || m === 'SUMIDO' || m === 'FERIAS'; // AG
    if (falta || emLoja.has(chave) || igual(h, 'FOLGA')) continue; // AI = "NAO - ..."
    const ini = minutos(h.slice(0, 5)), fim = minutos(h.slice(-5));
    const pr = h === 'SEM ESCALA DEFINIDA' || ini < 0 || fim < 0 ? 3 // AJ
      : (fim < ini ? agMin >= ini || agMin <= fim : agMin >= ini && agMin <= fim) ? 1 : agMin < ini ? 2 : 4;
    lista.push({ nome, tipo: contrato.toUpperCase(), horario: h, pr });
  }
  lista.sort((a, b) => a.pr - b.pr || a.tipo.localeCompare(b.tipo) || a.nome.localeCompare(b.nome));
  const conta = (f) => lista.filter(f).length;
  return {
    cards: { disponiveis: lista.length, elites: conta((x) => x.tipo === 'ELITE'), bases: conta((x) => x.tipo === 'BASE'),
      emServico: conta((x) => x.pr === 1), aEntrar: conta((x) => x.pr === 2), encerrados: conta((x) => x.pr === 4) },
    disponiveis: lista.map(({ nome, tipo, horario }) => ({ nome, tipo, horario })),
  };
}

// `dia`: linhas 2..199 da DIA ATUAL como objetos {B,D,E,H,I,J,K,L,M,N,Q,R}
export function operacao({ dia, dataRef, contratos, cabContratos, cadastro, metas, portaria }, agora = serialSP()) {
  const hoje = Math.floor(num(dataRef) || agora);

  // Status das lojas (A143:B147): loja preenchida e diferente de BASE
  const lojas = dia.filter((l) => txt(l.D) !== '' && norm(l.D) !== 'BASE');
  const status = ['CONFIRMADO', 'PRÉ CONFIRMADO', 'PENDENTE', 'EM ABERTO', 'ENTRAR EM CONTATO']
    .map((rotulo) => ({ rotulo, qtd: lojas.filter((l) => igual(l.J, rotulo)).length }));

  // Vagas por motivo (G4:H13): 10 mais frequentes; empate fica na ordem em que aparecem
  const cont = new Map();
  for (const l of dia) { const m = txt(l.M); if (m === '') continue; const k = m.toUpperCase(); const c = cont.get(k) || { rotulo: m, qtd: 0 }; c.qtd++; cont.set(k, c); }
  const categorias = [...cont.values()].sort((a, b) => b.qtd - a.qtd).slice(0, 10);

  // Custo médio (A46:F48): média de H por Tipo (L); H não numérico conta como 0
  const custoMedio = [['PRESTADOR', metas.prestador], ['MEI', metas.mei]].map(([tipo, meta]) => {
    const ls = dia.filter((l) => igual(l.L, tipo));
    const valor = ls.length ? ls.reduce((s, l) => s + num(l.H), 0) / ls.length : 0;
    return { tipo, valor, meta, qtd: ls.length, situacao: meta && valor / meta > 1 ? 'ACIMA' : 'DENTRO' };
  });

  // Tempo de reposição (AK156:AN353, F159:F164, A195:B197): (TEMPO FINAL − TEMPO INÍCIO) em horas
  const temp = dia.filter((l) => typeof l.K === 'number' && typeof l.N === 'number')
    .map((l) => ({ loja: txt(l.D), h: (l.N - l.K) * 24 })).filter((x) => x.h > 0);
  let tempoReposicao = [];
  if (temp.length) {
    const min = temp.reduce((a, b) => (b.h < a.h ? b : a)), max = temp.reduce((a, b) => (b.h > a.h ? b : a));
    const media = temp.reduce((s, x) => s + x.h, 0) / temp.length;
    tempoReposicao = [{ rotulo: min.loja || '—', horas: hmTrunc(min.h) }, { rotulo: 'MÉDIA GERAL', horas: hmTrunc(media) }, { rotulo: max.loja || '—', horas: hmTrunc(max.h) }];
  }

  // Lojas há mais tempo em aberto (AP201:AS398, A203:D212): sem TEMPO INÍCIO numérico ou já
  // resolvidas (CONFIRMADO, FOLGA, CONFIRMADO RETORNO) ficam fora. A planilha não tem a fórmula
  // na primeira linha (AS201); aqui a linha 2 da DIA ATUAL entra como as outras.
  const abertas = [];
  for (const l of dia) {
    const st = norm(l.J);
    if (txt(l.D) === '' || norm(l.D) === 'BASE' || typeof l.K !== 'number') continue;
    if (['CONFIRMADO', 'FOLGA', 'CONFIRMADO RETORNO', ''].includes(st)) continue;
    const h = Math.max(0, (l.K < 1 ? (agora - Math.floor(agora)) - l.K : agora - l.K) * 24);
    abertas.push({ loja: txt(l.D), tempo: hm(h), status: txt(l.J), h });
  }
  const lojasEmAberto = abertas.sort((a, b) => b.h - a.h).slice(0, 10).map(({ loja, tempo, status: s }) => ({ loja, tempo, status: s }));

  // Próximos retornos (A223#): faltantes com motivo FÉRIAS ou PROBLEMA DE SAÚDE; data na observação
  const retornos = [];
  for (const l of dia) {
    if (txt(l.Q).trim() === '') continue;
    const mn = norm(l.M);
    const ferias = mn.includes('FERIAS');
    if (!ferias && !mn.includes('PROBLEMA DE SAUDE')) continue;
    const t = txt(l.R), tU = t.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    let dt = null;
    if (tU.includes('CONFIRMADO RETORNO')) dt = hoje + 1;
    else {
      const ancora = ferias ? 'ATE' : 'RETORNA DIA';
      const p = tU.indexOf(ancora);
      if (p >= 0) {
        const resto = t.slice(p + ancora.length, p + ancora.length + 20).trim();
        const base = lerData10(resto) ?? lerData5(resto, anoDe(hoje));
        if (base != null) dt = base + (ferias ? 1 : 0);
      }
    }
    if (dt == null) continue;
    const d = dt - hoje;
    retornos.push({ nome: txt(l.Q), data: ddmm(dt), quando: d === 0 ? 'HOJE' : d === 1 ? 'AMANHÃ' : `${d} dias`, dt });
  }
  retornos.sort((a, b) => a.dt - b.dt);

  // Sumidos (A249#): faltantes com motivo SUMIDO; "sumido desde" = primeira data da observação
  const sumidos = [];
  for (const l of dia) {
    if (txt(l.Q).trim() === '' || !norm(l.M).includes('SUMIDO')) continue;
    const t = txt(l.R);
    let dt = null;
    for (let i = 0; i + 10 <= t.length && dt == null; i++) dt = lerData10(t.slice(i));
    for (let i = 0; i + 5 <= t.length && dt == null; i++) dt = lerData5(t.slice(i), anoDe(hoje));
    const nome = txt(l.Q);
    if (norm(nome) === 'FOLGA') continue; // lixo visto na origem em 03/10
    sumidos.push({ nome, desde: dt == null ? '' : new Date((dt - 25569) * 86400000).toISOString().slice(0, 10).split('-').reverse().join('/'), dias: dt == null ? '' : hoje - dt });
  }
  sumidos.sort((a, b) => (b.dias === '' ? -1 : b.dias) - (a.dias === '' ? -1 : a.dias));

  // Confirmar retorno (Hoje!M3): faltantes cuja observação pede CONFIRMAR RETORNO
  const confirmar = dia.filter((l) => txt(l.Q).trim() !== '' && norm(l.R).includes('CONFIRMAR RETORNO')).map((l) => txt(l.Q)).slice(0, 26);

  const esc = escala({ contratos, cabContratos, cadastro, dia }, agora);

  // Portaria (Hoje!I30): quem chegou hoje, ainda sem saída, do setor OPERACIONAL; 6 primeiros por hora
  let port = null;
  if (portaria) {
    port = [];
    portaria.ag.forEach((l, i) => {
      if (typeof l[0] !== 'number' || Math.floor(l[0]) !== Math.floor(agora)) return;
      if (txt(portaria.saida[i][0]) !== '' || !norm(l[4]).includes('OPERACIONAL')) return;
      const hora = txt(l[3]) === '' ? l[2] : l[3];
      // a hora vem como número do Excel ou como texto "hh:mm"
      const t = /(\d{1,2}):(\d{2})/.exec(txt(hora));
      const m = typeof hora === 'number' ? Math.round((hora % 1) * 1440) : t ? +t[1] * 60 + +t[2] : 0;
      port.push({ hora: `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`, nome: txt(l[6]), motivo: txt(l[5]), h: m });
    });
    port = port.sort((a, b) => a.h - b.h).slice(0, 6).map(({ hora, nome, motivo }) => ({ hora, nome, motivo }));
  }
  return {
    calculadoEm: new Date().toISOString(),
    fonte: 'Nova Operação (ao vivo)',
    ...esc,
    cards: { ...esc.cards, reposicoes: temp.length },
    resumo: `${esc.cards.emServico} em serviço · ${esc.cards.aEntrar} a entrar · ${esc.cards.encerrados} encerrados`,
    status, categorias, custoMedio, tempoReposicao, metaReposicao: hmTrunc(metas.reposicaoH),
    lojasEmAberto,
    retornos: retornos.map(({ nome, data, quando }) => ({ nome, data, quando })),
    sumidos, sumidosOcultos: 0,
    avisos: confirmar.length ? confirmar : ['SEM RETORNOS A CONFIRMAR'],
    portaria: port || [],
    portariaTexto: port && !port.length ? 'Ninguém na portaria agora' : '',
  };
}

// Planejamento = só o que é de fato do DIA SEGUINTE (pedido do Guilherme via ENG-A, 04/10;
// substitui o híbrido da planilha). Com a aba dd-mm-aaaa de amanhã já criada no Nova
// Operação (`entrada.diaAmanha`), todos os blocos saem dela, olhando amanhã às 12:00.
// Sem a aba, vai só a escala de amanhã; os demais blocos são omitidos (a página os esconde).
export function planejamento(entrada, op, agora = serialSP()) {
  const ref = Math.floor(agora) + 1 + 0.5;
  const dia = new Date((Math.floor(ref) - 25569) * 86400000).toISOString().slice(0, 10);
  if (entrada.diaAmanha) {
    const p = operacao({ ...entrada, dia: entrada.diaAmanha, dataRef: Math.floor(ref), portaria: null }, ref);
    delete p.portaria; delete p.portariaTexto;
    return { ...p, dia, fonte: `Nova Operação, aba de ${dia.split('-').reverse().join('/')}` };
  }
  const esc = escala({ ...entrada, dia: [] }, ref);
  return {
    calculadoEm: op.calculadoEm,
    fonte: 'Escala de amanhã (a aba do dia ainda não foi criada)',
    dia,
    ...esc,
    resumo: `${esc.cards.emServico} em serviço · ${esc.cards.aEntrar} a entrar · ${esc.cards.encerrados} encerrados`,
  };
}
