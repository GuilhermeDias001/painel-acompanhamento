// fixos.escala (folgas fixas e grupo de domingo dos motoristas da Farmoterápica) gerada a partir da planilha (Escalas F:K) + cadastro de motoristas,
// em vez da lista manual do fixos.json (27/10/2026, pedido do Guilherme via ENG-A: "o Carlos Gabriel desligado ainda aparecia em Hoje/Amanhã").
// Cada linha da planilha vira uma entrada; quem tem cadastro INATIVO fica de fora; o nome completo do cadastro vai em "cadastro" quando casa.
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const tcase = (s) => String(s || '').toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
// na planilha o sobrenome sai como ALVEZ e no cadastro como ALVES: compara com Z=S
const toks = (s) => norm(s).replace(/Z/g, 'S').split(' ').filter(Boolean);
function casaCadastro(nome, cad) {
  const t = toks(nome); if (!t.length) return null;
  const achados = cad.filter((m) => { const c = toks(m.nome); const a = toks(m.apelido); return (t.every((w) => c.includes(w)) && c[0] === t[0]) || (a.length && t.join(' ') === a.join(' ')); });
  return achados.length === 1 ? achados[0] : null; // 0 ou vários (ex.: dois Eduardo Alves): não adivinha
}
export function escalaFixosDoFarmoOp(farmoOp, cadastroMotoristas, anterior = {}) {
  const linhas = (farmoOp && farmoOp.folgasMotoristas) || [], cad = cadastroMotoristas || [];
  const grupoDe = new Map(((farmoOp && farmoOp.escalaSemanal) || []).map((x) => [norm(x.motorista), String(x.grupo || '')]));
  const escala = {}, ignorados = [];
  for (const l of linhas) {
    const nome = norm(l.motorista); if (!nome || /^FALTA/.test(nome)) continue;
    let m = casaCadastro(nome, cad);
    const prev = Object.entries(anterior).find(([k]) => toks(k).join(' ') === toks(nome).join(' '));
    if (!m && prev && prev[1].cadastro) m = cad.find((x) => norm(x.nome) === norm(prev[1].cadastro)) || { nome: prev[1].cadastro, ativo: true };
    if (m && m.ativo === false) { ignorados.push(tcase(nome) + ' (cadastro inativo)'); continue; }
    const g = norm(grupoDe.get(nome) || ''), tipo = /MOTOBOY/.test(g) ? 'motoboy' : /MOTORISTA/.test(g) ? 'motorista' : /MEI/.test(g) ? 'mei' : (anterior[tcase(nome)]?.tipo || 'motorista');
    const dias = [parseInt(l.cod, 10), parseInt(l.cod2, 10)].filter((n) => n >= 1 && n <= 6), domFixo = parseInt(l.cod2, 10) === 7 || parseInt(l.cod, 10) === 7;
    const gd = parseInt(l.domingo, 10);
    const e = { fixos: dias, grupoDom: gd >= 1 ? gd : null, tipo };
    if (domFixo) e.domFixo = true;
    if (m) e.cadastro = m.nome;
    escala[tcase(nome)] = e;
  }
  return { escala, ignorados };
}
