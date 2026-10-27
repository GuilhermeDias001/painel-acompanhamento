// Revisão das regiões das lojas (27/10/2026, pedido do Guilherme: "Nova Farma 104 fica em Guarulhos mas na Reposição mostra outra região").
// A coluna de região da planilha mistura zona de SP ("ZL"), cidade ("GUARULHOS") e abreviações ("Mogi das C."). Aqui:
//  1) padroniza o nome da cidade (uma só grafia por cidade, para a Reposição não dividir "Mogi das C." e "Mogi das Cruzes");
//  2) se a planilha põe uma ZONA de São Paulo (ZL/ZN/ZS/ZO) numa loja cujo endereço é de OUTRA cidade, a região vira a cidade do endereço.
// 27/10 (Guilherme: "aplicar a posição nas 12 e a sugestão nas sem região"): zona de SP diferente da posição do endereço passa a ser a da posição; loja sem região recebe a sugestão. 27/10 (2º pedido): região de cidade diferente da cidade do endereço passa a seguir o endereço (capital = zona pela posição; outra cidade = a cidade).
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const CIDADES = {
  'MOGI DAS C.': 'Mogi das Cruzes', 'MOGI DAS CRUZES': 'Mogi das Cruzes', 'MOGI': 'Mogi das Cruzes',
  'FERRAZ DE VASC.': 'Ferraz de Vasconcelos', 'FERRAZ DE VASCONCELOS': 'Ferraz de Vasconcelos',
  'ITAQUA': 'Itaquaquecetuba', 'ITAQUAQUECETUBA': 'Itaquaquecetuba',
  'SANTO ANDRE - SP,': 'Santo André', 'SANTO ANDRE - SP': 'Santo André', 'SANTO ANDRE': 'Santo André',
  'SCS': 'São Caetano do Sul', 'SAO CAETANO DO SUL': 'São Caetano do Sul',
  'ARUJA': 'Arujá', 'GUARULHOS': 'Guarulhos', 'DIADEMA': 'Diadema', 'SUZANO': 'Suzano', 'BARUERI': 'Barueri',
  'CARAPICUIBA': 'Carapicuíba', 'OSASCO': 'Osasco', 'TABOAO DA SERRA': 'Taboão da Serra', 'SAO BERNARDO DO CAMPO': 'São Bernardo do Campo',
  'POA': 'Poá', 'FRANCO DA ROCHA': 'Franco da Rocha', 'MAUA': 'Mauá', 'RIBEIRAO PIRES': 'Ribeirão Pires',
};
const cidadeCanon = (c) => CIDADES[norm(c)] || '';
function cidadeDoEndereco(end) {
  const m = /([^,]+?)\s*-\s*SP\b/i.exec(end || ''); if (!m) return '';
  return m[1].trim().split(/\s+-\s+/).pop().trim();
}
const ehZona = (r) => /^(ZONA (LESTE|NORTE|SUL|OESTE)|Z[LNSO]|LESTE|NORTE|SUL|OESTE)$/.test(norm(r));
const zonaDaPosicao = (l) => {
  if (typeof l.lat !== 'number' || typeof l.lng !== 'number') return '';
  const dy = l.lat + 23.5505, dx = (l.lng + 46.6333) * Math.cos(23.55 * Math.PI / 180);
  if (Math.sqrt(dx * dx + dy * dy) * 111 <= 3.5) return 'Centro';
  return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'Zona Leste' : 'Zona Oeste') : (dy > 0 ? 'Zona Norte' : 'Zona Sul');
};
const zonaNome = (r) => { const t = norm(r); const z = { L: 'Zona Leste', N: 'Zona Norte', S: 'Zona Sul', O: 'Zona Oeste' }; return /^ZONA /.test(t) ? z[t.split(' ')[1][0]] : (/^Z[LNSO]$/.test(t) ? z[t[1]] : (z[t[0]] || '')); };

export function normalizarRegioes(lojas) {
  const aplicadas = { zonaPorPosicao: 0, semRegiao: 0, cidadePeloEndereco: 0 }, corrigidas = [], padronizadas = [], revisar = { zonaDiferenteDaPosicao: [], cidadeDiferenteDoEndereco: [], semRegiao: [] };
  for (const l of lojas || []) {
    const end = l.endereco || ''; if (!end) continue;
    if (/\/\s*LOJA|LOJA\s*\d+\s*:/i.test(end) || (end.match(/ - SP/gi) || []).length > 1) continue; // vários endereços num cadastro só
    const cidEnd = cidadeDoEndereco(end), capital = norm(cidEnd) === 'SAO PAULO', antes = l.regiao || '';
    if (!antes) { const sug = capital ? zonaDaPosicao(l) : (cidadeCanon(cidEnd) || cidEnd); revisar.semRegiao.push({ loja: l.nome, cidade: cidEnd, sugestao: sug }); if (sug) { l.regiao = sug; l.regiaoPlanilha = ''; aplicadas.semRegiao++; } continue; }
    if (ehZona(antes) && cidEnd && !capital) {
      const nova = cidadeCanon(cidEnd) || cidEnd.replace(/\b\w/g, (c) => c.toUpperCase());
      l.regiaoPlanilha = antes; l.regiao = nova; corrigidas.push({ loja: l.nome, de: antes, para: nova, cidade: cidEnd }); continue;
    }
    const canon = cidadeCanon(antes);
    if (canon && canon !== antes) { l.regiaoPlanilha = antes; l.regiao = canon; padronizadas.push({ loja: l.nome, de: antes, para: canon }); }
    const atual = l.regiao;
    if (ehZona(atual) && capital) { const der = zonaDaPosicao(l); if (der && der !== zonaNome(atual)) { revisar.zonaDiferenteDaPosicao.push({ loja: l.nome, planilha: atual, posicao: der }); l.regiaoPlanilha = atual; l.regiao = der; aplicadas.zonaPorPosicao++; } }
    else if (!ehZona(atual) && cidadeCanon(atual) && cidEnd && cidadeCanon(atual) !== (cidadeCanon(cidEnd) || cidEnd)) { revisar.cidadeDiferenteDoEndereco.push({ loja: l.nome, regiao: atual, enderecoCidade: cidEnd }); const nova = capital ? zonaDaPosicao(l) : (cidadeCanon(cidEnd) || cidEnd); if (nova) { l.regiaoPlanilha = atual; l.regiao = nova; aplicadas.cidadePeloEndereco++; } }
  }
  return { corrigidas, padronizadas, revisar, aplicadas };
}
