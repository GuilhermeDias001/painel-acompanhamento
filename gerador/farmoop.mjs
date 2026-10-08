// Parte OPERACIONAL da Farmoterápica (Assistente Farmoterápica: Operação, Devolução, Rotas, Escalas, Historico), só leitura.
// Pedido do ENG-A/Guilherme 07-08/10. NUNCA lê as colunas sensíveis da aba Motorista (usuário, CNH, CPF, placa) nem Pix.
// `ler(aba, 'A1:Z9')` -> matriz de valores.
const txt = (v) => (v == null ? '' : String(v)).trim();
const iso = (s) => (typeof s === 'number' && s > 30000 ? new Date((s - 25569) * 86400000).toISOString().slice(0, 10) : '');
const hhmm = (v) => { if (typeof v !== 'number') return txt(v); const m = Math.round((v % 1) * 1440); return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const pad = (m, n, c) => Array.from({ length: n }, (_, r) => Array.from({ length: c }, (_, i) => (m[r] || [])[i] ?? ''));

export async function montarFarmoOp(ler) {
  const out = {};

  // --- Rotas: A:B endereços cadastrados por rota; C:D rota -> titular; F:H trocas do dia; J motorista do dia; K:M catálogo de códigos; N parâmetros
  const R = pad(await ler('Rotas', 'A2:J300'), 300, 10);
  out.enderecosPorRota = R.filter((l) => txt(l[0]) && txt(l[1])).map((l) => ({ rota: txt(l[0]), endereco: txt(l[1]) }));
  out.rotas = R.map((l, i) => ({ rota: txt(l[2]), titular: txt(l[3]), motoristaDia: txt(l[9]) })).filter((x) => x.rota);
  out.trocas = R.filter((l) => txt(l[6])).map((l) => ({ rotaAntiga: txt(l[5]), endereco: txt(l[6]), novaRota: txt(l[7]) }));
  out.motoristasDia = R.map((l) => txt(l[9])).filter(Boolean);
  const cat = pad(await ler('Rotas', 'L2:M500'), 500, 2);
  out.codigosBolsa = cat.map((l) => txt(l[0])).filter(Boolean);
  out.codigosTermometro = cat.map((l) => txt(l[1])).filter(Boolean);
  const par = await ler('Rotas', 'N2:N6'); // limite de ocupação, capacidade (litros), última linha da grade
  out.parametros = { limiteOcupacao: typeof par[0]?.[0] === 'number' ? par[0][0] : 0.85, capacidadeLitros: typeof par[2]?.[0] === 'number' ? par[2][0] : 90, linhaFinalGrade: typeof par[4]?.[0] === 'number' ? par[4][0] : 199 };

  // --- Operação: seções = linha com A preenchido e B vazio; linhas = endereço, horário, bairro, código PNET (+ lançamento, se já houver)
  const cab = pad(await ler('Operação', 'A1:I2'), 2, 9);
  out.dataHoje = iso(cab[1][8]);
  out.statusOperacao = txt(cab[0][2]);
  out.turnoRotulo = txt(cab[0][0]);
  const O = pad(await ler('Operação', 'A3:H200'), 198, 8);
  const linhas = []; let rota = '';
  O.forEach((l, i) => {
    const a = txt(l[0]);
    if (!a) return;
    if (txt(l[1]) === '' && txt(l[2]) === '' && txt(l[3]) === '') { rota = a; return; }
    linhas.push({ linha: i + 3, rota, endereco: a, horario: hhmm(l[1]), bairro: txt(l[2]), codigoPnet: txt(l[3]), sugestao: txt(l[4]), portador: txt(l[5]), bolsa: txt(l[6]), termometro: txt(l[7]) });
  });
  out.operacaoHoje = linhas;

  // --- Devolução do dia: manhã A:F, tarde H:M (data, bolsa P/M/G, 2 termômetros)
  const D = pad(await ler('Devolução', 'A4:N23'), 20, 14);
  const linhaDev = (l, c) => ({ bolsaP: txt(l[c + 1]), bolsaM: txt(l[c + 2]), bolsaG: txt(l[c + 3]), termometro1: txt(l[c + 4]), termometro2: txt(l[c + 5]) });
  const cheia = (x) => Object.values(x).some(Boolean);
  const st = await ler('Devolução', 'N2:N2');
  out.devolucaoHoje = { data: iso(D[0][0]) || out.dataHoje, status: txt(st[0]?.[0]),
    manha: D.map((l) => linhaDev(l, 0)).filter(cheia), tarde: D.map((l) => linhaDev(l, 7)).filter(cheia) };

  // --- Escalas: internos (A:E), motoristas e folgas (F:K) e escala semanal dinâmica (L:S; 🟢 trabalha, 🔴 folga)
  const E = pad(await ler('Escalas', 'A3:S70'), 68, 19);
  out.escalaInternos = E.filter((l) => typeof l[0] === 'number').map((l) => ({ data: iso(l[0]), dia: txt(l[1]), altoTiete: txt(l[2]), litoral: txt(l[3]), obs: txt(l[4]) }));
  out.folgasMotoristas = E.filter((l) => txt(l[5])).map((l) => ({ motorista: txt(l[5]), diaFolga: txt(l[6]), cod: txt(l[7]), cod2: txt(l[8]), domingo: txt(l[9]), tipo: txt(l[10]) }));
  const dias = ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'];
  let grupo = ''; const semana = [];
  for (const l of E) {
    const n = txt(l[11]); if (!n) continue;
    if (txt(l[12]) === '' && !txt(l[18])) { grupo = n.replace(/^[^\p{L}]+/u, '').trim(); continue; }
    semana.push({ grupo, motorista: n, ...Object.fromEntries(dias.map((d, i) => [d, txt(l[12 + i]) === '🟢' ? 'T' : txt(l[12 + i]) === '🔴' ? 'F' : txt(l[12 + i])])) });
  }
  out.escalaSemanal = semana;
  const sem = await ler('Escalas', 'S1:S1'); out.semanaNumero = sem[0]?.[0] ?? null;

  // --- Motorista: SÓ as colunas A:B (rota -> motorista); C:H têm usuário, CNH, CPF e placa e não são lidas
  const M = pad(await ler('Motorista', 'A2:B40'), 39, 2);
  const por = (r) => txt((M.find((l) => txt(l[0]).toUpperCase() === r) || [])[1]);
  out.folguista = por('FOLGUISTA');
  out.coringa = por('CORINGA');

  // --- dia fechado =a data de hoje já consta no Historico (coluna A)
  const H = await ler('Historico', 'A2:A20000');
  const datas = new Set(H.map((l) => iso(l[0])).filter(Boolean));
  out.diasFechados = [...datas].sort().slice(-90);
  out.diaFechado = datas.has(out.dataHoje);
  return out;
}
