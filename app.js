(() => {
  'use strict';

  const URL_BANCO = 'data/condicoes.json';
  const LS_VERSOES = 'rrp_versoes'; // suas versões salvas: { idDaCondicao: { campo: { t: texto, b: original } } }
  // [campo do índice, peso na pontuação]
  const CAMPOS = [['nome', 5], ['cid', 5], ['sin', 4], ['sint', 2], ['tags', 1]];
  const ROTULO = { sin: 'sinônimo', sint: 'sintoma', tags: 'tag' };
  const BLOCOS = [
    { campo: 'receita', titulo: 'Receita', extra: '' },
    { campo: 'orientacoes', titulo: 'Orientações', extra: '' },
    { campo: 'sinais_alarme', titulo: 'Sinais de alarme', extra: 'alarme' },
  ];
  const TEM_COLCHETES = /\[[^\]]*\]/;

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
  let estado = {}; // estado dos 3 blocos da condição aberta

  /* ---------- armazenamento no aparelho ---------- */

  function lerLS(chave, padrao) {
    try {
      const v = localStorage.getItem(chave);
      return v ? JSON.parse(v) : padrao;
    } catch (e) { return padrao; }
  }

  function gravarLS(chave, valor) {
    try { localStorage.setItem(chave, JSON.stringify(valor)); return true; }
    catch (e) { return false; }
  }

  let versoes = lerLS(LS_VERSOES, {});
  if (!versoes || typeof versoes !== 'object' || Array.isArray(versoes)) versoes = {};

  // salva (ou apaga, se o texto for igual ao original) a sua versão de um bloco
  function gravarVersao(id, campo, valor, orig) {
    const copia = JSON.parse(JSON.stringify(versoes));
    if (!copia[id] || typeof copia[id] !== 'object') copia[id] = {};
    if (valor === orig) delete copia[id][campo];
    else copia[id][campo] = { t: valor, b: orig };
    if (!Object.keys(copia[id]).length) delete copia[id];
    if (!gravarLS(LS_VERSOES, copia)) return false;
    versoes = copia;
    return true;
  }

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

  function casar(t, w) {
    if (w === t) return 3;
    if (w.startsWith(t)) return 2.5;
    if (t.length >= 3 && w.includes(t)) return 1.5;
    return 0;
  }

  function aproximar(t, w) {
    const n = t.length;
    if (n < 4 || /\d/.test(t)) return 0;
    const max = n >= 8 ? 2 : 1;
    if (Math.abs(w.length - n) <= max && lev(t, w) <= max) return 1;
    if (w.length > n && lev(t, w.slice(0, n)) <= max) return 0.8;
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

  /* ---------- copiar ---------- */

  async function copiarTexto(t) {
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(t); return true; } catch (e) { /* plano B abaixo */ }
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px;';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, t.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  function piscar(btn, msg, rotulo, classe, ms) {
    btn.textContent = msg;
    btn.classList.add(classe);
    clearTimeout(btn._t);
    btn._t = setTimeout(() => {
      btn.textContent = rotulo;
      btn.classList.remove(classe);
    }, ms || 1600);
  }

  async function executarCopia(btn, rotulo, obterTexto, aoFalhar) {
    const txt = obterTexto();
    if (!txt.trim()) { piscar(btn, 'Texto vazio', rotulo, 'erro'); return; }
    const ok = await copiarTexto(txt);
    if (ok) {
      piscar(btn, 'Copiado ✓', rotulo, 'ok');
      try { if (navigator.vibrate) navigator.vibrate(25); } catch (e) {}
    } else {
      piscar(btn, 'Não copiou. Copie manualmente', rotulo, 'erro', 3500);
      if (aoFalhar) aoFalhar();
    }
  }

  // botão com confirmação em 2 toques quando "precisa()" for verdadeiro
  function ligarBotao(btn, { rotulo, aviso, precisa, acao }) {
    let armado = false;
    let t = null;
    const desarmar = () => {
      armado = false;
      clearTimeout(t);
      btn.classList.remove('armado');
      btn.textContent = rotulo;
    };
    btn.addEventListener('click', () => {
      if (!armado && precisa()) {
        armado = true;
        btn.classList.add('armado');
        btn.textContent = aviso;
        t = setTimeout(desarmar, 5000);
        return;
      }
      desarmar();
      acao(btn, rotulo);
    });
  }

  function montarTudo() {
    return BLOCOS
      .map((b) => ({ t: b.titulo.toUpperCase(), v: estado[b.campo].ta.value.trim() }))
      .filter((x) => x.v)
      .map((x) => x.t + '\n' + x.v)
      .join('\n\n');
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

  const ajustar = (ta) => {
    ta.style.height = 'auto';
    ta.style.height = (ta.scrollHeight + 2) + 'px';
  };

  function blocoHTML(b) {
    return (
      '<section class="bloco ' + b.extra + '" data-campo="' + b.campo + '">' +
      '<div class="bloco-topo"><h3>' + esc(b.titulo) + '</h3><span class="selo" data-selo hidden></span></div>' +
      '<textarea class="campo" data-ta spellcheck="false" autocapitalize="off" autocorrect="off" ' +
      'aria-label="' + esc(b.titulo) + '"></textarea>' +
      '<button type="button" class="btn btn-copiar" data-copiar>Copiar ' + esc(b.titulo.toLowerCase()) + '</button>' +
      '<div class="edicao" data-edicao>' +
      '<button type="button" class="btn-sec" data-temp>Usar só desta vez</button>' +
      '<button type="button" class="btn-sec principal" data-salvar>Salvar como minha versão</button>' +
      '<button type="button" class="btn-sec principal" data-manter>Manter minha versão</button>' +
      '<button type="button" class="btn-sec" data-restaurar>Restaurar original</button>' +
      '</div></section>'
    );
  }

  function montarBloco(c, b) {
    const sec = $app.querySelector('[data-campo="' + b.campo + '"]');
    const ta = sec.querySelector('[data-ta]');
    const selo = sec.querySelector('[data-selo]');
    const edicao = sec.querySelector('[data-edicao]');
    const btnTemp = sec.querySelector('[data-temp]');
    const btnSalvar = sec.querySelector('[data-salvar]');
    const btnManter = sec.querySelector('[data-manter]');
    const btnRest = sec.querySelector('[data-restaurar]');
    const btnCopiar = sec.querySelector('[data-copiar]');

    const orig = texto(c[b.campo]);
    const reg = (versoes[c.id] || {})[b.campo];
    const valido = !!reg && typeof reg.t === 'string';
    const e = (estado[b.campo] = {
      orig,
      salvo: valido ? reg.t : null,
      base: valido ? reg.b : null,
      temp: false,
      ta,
    });
    ta.value = e.salvo !== null ? e.salvo : orig;

    function atualizar() {
      const baseAtual = e.salvo !== null ? e.salvo : e.orig;
      const sujo = ta.value !== baseAtual;
      const desatualizado = e.salvo !== null && e.base !== e.orig;
      let msg = '';
      if (sujo) msg = e.temp ? 'Edição só desta vez (não salva)' : 'Editado, ainda não salvo';
      else if (e.salvo !== null) msg = 'Sua versão salva';
      if (desatualizado) msg += (msg ? ' · ' : '') + '⚠ o texto original foi atualizado';
      selo.textContent = msg;
      selo.hidden = !msg;
      selo.className = 'selo' + (sujo || desatualizado ? ' aviso' : '');
      btnTemp.hidden = btnSalvar.hidden = !(sujo && !e.temp);
      btnManter.hidden = !(desatualizado && !sujo);
      btnRest.hidden = !(e.salvo !== null || ta.value !== e.orig);
      edicao.hidden = btnTemp.hidden && btnSalvar.hidden && btnManter.hidden && btnRest.hidden;
    }

    function salvar(valor) {
      if (!gravarVersao(c.id, b.campo, valor, e.orig)) {
        alert('Não consegui salvar neste navegador (modo anônimo ou armazenamento bloqueado).');
        return;
      }
      e.salvo = valor === e.orig ? null : valor;
      e.base = e.salvo === null ? null : e.orig;
      e.temp = false;
      atualizar();
    }

    ta.addEventListener('input', () => {
      e.temp = false;
      ajustar(ta);
      atualizar();
    });
    btnTemp.addEventListener('click', () => { e.temp = true; atualizar(); });
    btnSalvar.addEventListener('click', () => salvar(ta.value));
    btnManter.addEventListener('click', () => salvar(e.salvo));

    ligarBotao(btnRest, {
      rotulo: 'Restaurar original',
      aviso: 'Toque de novo para restaurar',
      precisa: () => true,
      acao: () => {
        if (e.salvo !== null && !gravarVersao(c.id, b.campo, e.orig, e.orig)) {
          alert('Não consegui apagar a sua versão salva neste navegador.');
          return;
        }
        e.salvo = null;
        e.base = null;
        e.temp = false;
        ta.value = e.orig;
        ajustar(ta);
        atualizar();
      },
    });

    ligarBotao(btnCopiar, {
      rotulo: 'Copiar ' + b.titulo.toLowerCase(),
      aviso: 'Tem [campos]. Copiar mesmo assim?',
      precisa: () => TEM_COLCHETES.test(ta.value),
      acao: (btn, rotulo) =>
        executarCopia(btn, rotulo, () => ta.value.trim(), () => { ta.focus(); ta.select(); }),
    });

    ajustar(ta);
    atualizar();
  }

  function renderCondicao(id) {
    const c = condicoes.find((x) => x.id === id);
    if (!c) {
      $app.innerHTML =
        '<a class="voltar" href="#/">← Voltar</a>' +
        '<div class="vazio"><p>Condição não encontrada.</p></div>';
      return;
    }
    estado = {};
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
      BLOCOS.map((b) => blocoHTML(b)).join('') +
      '</article>' +
      '<div class="barra-copiar"><button type="button" class="btn cheio" id="btn-tudo">Copiar tudo</button></div>';

    BLOCOS.forEach((b) => montarBloco(c, b));

    ligarBotao(document.getElementById('btn-tudo'), {
      rotulo: 'Copiar tudo',
      aviso: 'Tem [campos]. Copiar tudo mesmo assim?',
      precisa: () => TEM_COLCHETES.test(montarTudo()),
      acao: (btn, rotulo) => executarCopia(btn, rotulo, montarTudo),
    });

    window.scrollTo(0, 0);
    requestAnimationFrame(() => BLOCOS.forEach((b) => ajustar(estado[b.campo].ta)));
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
