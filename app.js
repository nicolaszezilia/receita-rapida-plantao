(() => {
  'use strict';

  const URL_BANCO = 'data/condicoes.json';
  // [campo do índice, peso na pontuação]
  const CAMPOS = [['nome', 5], ['cid', 5], ['sin', 4], ['sint', 2], ['tags', 1]];
  const ROTULO = { sin: 'sinônimo', sint: 'sintoma', tags: 'tag' };

  const $app = document.getElementById('app');
  const $busca = document.getElementById('busca');
  const $limpar = document.getElementById('btn-limpar');
  const $tema = document.getElementById('btn-tema');

  let condicoes = [];
  let indice = [];
  let pronto = false;
  let consulta = '';
  let scrollLista = 0;
  let abriuDaLista = false;
  let timer = null;

  /* ---------- utilidades ---------- */

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  // aceita lista de linhas ou texto simples
  const texto = (v) => (Array.isArray(v) ? v.join('\n') : v == null ? '' : String(v));

  // minúsculas, sem acento; "J03.0" vira "j030"
  const norm = (s) =>
    texto(s)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/(\d)[.,](\d)/g, '$1$2')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();

  const palavras = (v) => norm(v).split(' ').filter(Boolean);

  // distância de edição (inclui troca de letras vizinhas)
  function lev(a, b) {
    const m = a.length, n = b.length, d = [];
    for (let i = 0; i <= m; i++) d[i] = [i];
    for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const c = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
      }
    }
    return d[m][n];
  }

  /* ---------- busca ---------- */

  function construirIndice(c) {
    return {
      c,
      nome: palavras(c.nome),
      cid: palavras(c.cid),
      sin: palavras(c.sinonimos),
      sint: palavras(c.sintomas),
      tags: palavras(c.tags),
    };
  }

  // t = trecho digitado, w = palavra do banco (ambos normalizados)
  function casar(t, w) {
    if (w === t) return 3;
    if (w.startsWith(t)) return 2.5;
    if (t.length >= 3 && w.includes(t)) return 1.5;
    return 0;
  }

  function aproximar(t, w) {
    const n = t.length;
    if (n < 4 || /\d/.test(t)) return 0; // sem tolerância para curtos e para códigos CID
    const max = n >= 8 ? 2 : 1;
    if (Math.abs(w.length - n) <= max && lev(t, w) <= max) return 1;
    if (w.length > n && lev(t, w.slice(0, n)) <= max) return 0.8; // erro no meio da digitação
    return 0;
  }

  function buscar(q) {
    const tokens = norm(q).split(' ').filter(Boolean);
    if (!tokens.length) {
      return indice
        .map((it) => ({ c: it.c, score: 0, campos: new Set() }))
        .sort((a, b) => a.c.nome.localeCompare(b.c.nome, 'pt-BR'));
    }
    const res = [];
    for (const it of indice) {
      let total = 0;
      let ok = true;
      const campos = new Set();
      for (const t of tokens) {
        let melhor = 0, campoMelhor = null;
        for (const [campo, peso] of CAMPOS) {
          const ws = it[campo];
          let s = 0;
          for (const w of ws) {
            const v = casar(t, w);
            if (v > s) s = v;
            if (s === 3) break;
          }
          if (s === 0) for (const w of ws) { const v = aproximar(t, w); if (v > s) s = v; }
          if (s * peso > melhor) { melhor = s * peso; campoMelhor = campo; }
        }
        if (!melhor) { ok = false; break; }
        total += melhor;
        campos.add(campoMelhor);
      }
      if (ok) res.push({ c: it.c, score: total, campos });
    }
    res.sort((a, b) => b.score - a.score || a.c.nome.localeCompare(b.c.nome, 'pt-BR'));
    return res;
  }

  /* ---------- telas ---------- */

  function renderLista() {
    const res = buscar(consulta);
    if (!res.length) {
      $app.innerHTML =
        '<div class="vazio"><p><strong>Nada encontrado</strong> para “' + esc(consulta) + '”.</p>' +
        '<p>Tente outra palavra, o sintoma ou o código CID.</p></div>';
      return;
    }
    const itens = res.map(({ c, campos }) => {
      const tags = (c.tags || []).map((t) => '<span class="tag">' + esc(t) + '</span>').join('');
      let via = '';
      if (consulta && !campos.has('nome') && !campos.has('cid')) {
        const nomes = [...campos].map((k) => ROTULO[k]).filter(Boolean);
        if (nomes.length) via = '<div class="via">encontrado em: ' + esc(nomes.join(', ')) + '</div>';
      }
      return (
        '<li><a class="item" href="#/c/' + encodeURIComponent(c.id) + '">' +
        '<div class="item-topo"><span class="item-nome">' + esc(c.nome) + '</span>' +
        (c.cid ? '<span class="item-cid">' + esc(c.cid) + '</span>' : '') + '</div>' +
        (tags ? '<div class="tags">' + tags + '</div>' : '') + via +
        '</a></li>'
      );
    }).join('');
    $app.innerHTML =
      '<p class="contagem">' + res.length + (res.length === 1 ? ' condição' : ' condições') + '</p>' +
      '<ul class="lista">' + itens + '</ul>';
  }

  function bloco(titulo, valor, extra) {
    return (
      '<section class="bloco ' + (extra || '') + '"><h3>' + esc(titulo) + '</h3>' +
      '<pre class="texto">' + esc(texto(valor)) + '</pre></section>'
    );
  }

  function renderCondicao(id) {
    const c = condicoes.find((x) => x.id === id);
    if (!c) {
      $app.innerHTML =
        '<a class="voltar" href="#/">← Voltar</a>' +
        '<div class="vazio"><p>Condição não encontrada.</p></div>';
      return;
    }
    const tags = (c.tags || []).map((t) => '<span class="tag">' + esc(t) + '</span>').join('');
    $app.innerHTML =
      '<a class="voltar" href="#/">← Voltar</a>' +
      '<article class="cond">' +
      '<h2>' + esc(c.nome) + '</h2>' +
      '<div class="meta">' + (c.cid ? '<span>CID-10 ' + esc(c.cid) + '</span>' : '') + tags + '</div>' +
      (c.revisado === true ? '' : '<p class="aviso-rev">⚠ Conteúdo ainda não revisado por você. Confira antes de usar.</p>') +
      (c.nota_revisao
        ? '<details class="nota"><summary>Nota para revisão</summary><p>' + esc(texto(c.nota_revisao)) + '</p></details>'
        : '') +
      bloco('Receita', c.receita) +
      bloco('Orientações', c.orientacoes) +
      bloco('Sinais de alarme', c.sinais_alarme, 'alarme') +
      '</article>';
    window.scrollTo(0, 0);
  }

  function mostrarErro(e) {
    $app.innerHTML =
      '<div class="erro"><h2>Não consegui carregar o banco de condições</h2>' +
      '<p><code>' + esc(e && e.message ? e.message : e) + '</code></p>' +
      '<ul><li>Abra o app pelo endereço publicado (https://...), não pelo arquivo salvo no celular.</li>' +
      '<li>Se você editou o <code>condicoes.json</code>, confira vírgulas, aspas e colchetes.</li></ul>' +
      '<button class="btn" type="button" id="btn-recarregar">Tentar de novo</button></div>';
    document.getElementById('btn-recarregar').addEventListener('click', () => location.reload());
  }

  /* ---------- rotas ---------- */

  function rotear() {
    if (!pronto) return;
    const m = (location.hash || '#/').match(/^#\/c\/(.+)$/);
    if (m) {
      let id = m[1];
      try { id = decodeURIComponent(id); } catch (e) {}
      renderCondicao(id);
    } else {
      renderLista();
      window.scrollTo(0, scrollLista);
      scrollLista = 0;
    }
  }

  $app.addEventListener('click', (e) => {
    if (e.target.closest('a.item')) {
      scrollLista = window.scrollY;
      abriuDaLista = true;
      return;
    }
    if (e.target.closest('.voltar')) {
      e.preventDefault();
      if (abriuDaLista) { abriuDaLista = false; history.back(); }
      else { location.hash = '#/'; }
    }
  });

  /* ---------- busca na tela ---------- */

  function aoDigitar() {
    consulta = $busca.value;
    $limpar.hidden = !consulta;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if ((location.hash || '').startsWith('#/c/')) {
        history.replaceState(null, '', '#/');
        abriuDaLista = false;
      }
      scrollLista = 0;
      renderLista();
      window.scrollTo(0, 0);
    }, 90);
  }

  $busca.addEventListener('input', aoDigitar);
  $busca.addEventListener('keydown', (e) => { if (e.key === 'Enter') $busca.blur(); });
  $limpar.addEventListener('click', () => {
    $busca.value = '';
    $busca.focus();
    aoDigitar();
  });

  $tema.addEventListener('click', () => {
    const el = document.documentElement;
    const atual = el.dataset.tema ||
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'escuro' : 'claro');
    const novo = atual === 'escuro' ? 'claro' : 'escuro';
    el.dataset.tema = novo;
    try { localStorage.setItem('rrp_tema', novo); } catch (e) {}
  });

  window.addEventListener('hashchange', rotear);

  /* ---------- carga do banco ---------- */

  async function carregar() {
    $app.innerHTML = '<p class="carregando">Carregando…</p>';
    try {
      const r = await fetch(URL_BANCO, { cache: 'no-cache' });
      if (!r.ok) throw new Error('Arquivo ' + URL_BANCO + ' não encontrado (HTTP ' + r.status + ').');
      const dados = await r.json();
      if (!dados || !Array.isArray(dados.condicoes)) {
        throw new Error('Formato inválido: falta a lista "condicoes" no JSON.');
      }
      const vistos = new Set();
      condicoes = dados.condicoes.filter((c) => {
        if (!c || !c.id || !c.nome) { console.warn('Condição ignorada (sem id ou nome):', c); return false; }
        if (vistos.has(c.id)) { console.warn('id repetido, ignorado:', c.id); return false; }
        vistos.add(c.id);
        return true;
      });
      indice = condicoes.map(construirIndice);
      pronto = true;
      rotear();
    } catch (e) {
      mostrarErro(e);
    }
  }

  carregar();
})();
