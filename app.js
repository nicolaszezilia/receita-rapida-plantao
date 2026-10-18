(() => {
  'use strict';

  const URL_BANCO = 'data/condicoes.json';
  const LS_VERSOES = 'rrp_versoes'; // { idDaCondicao: { campo: { t: texto, b: original } } }
  const LS_FAV = 'rrp_favoritos'; // [ids]
  const LS_REC = 'rrp_recentes'; // [ids]
  const LS_BACKUP = 'rrp_ultimo_backup'; // data ISO do último backup
  const LS_ALTERADO = 'rrp_alterado'; // data ISO da última mudança nos textos salvos
  const MAX_RECENTES = 10;
  const MOSTRAR_RECENTES = 5;
  const NOME_APP = 'receita-rapida-plantao';

  // [campo do índice, peso na pontuação]
  const CAMPOS = [['nome', 5], ['cid', 5], ['sin', 4], ['sint', 2], ['tags', 1]];
  const ROTULO = { sin: 'sinônimo', sint: 'sintoma', tags: 'tag' };
  const BLOCOS = [
    { campo: 'receita', titulo: 'Receita', extra: '' },
    { campo: 'orientacoes', titulo: 'Orientações', extra: '' },
    { campo: 'sinais_alarme', titulo: 'Sinais de alarme', extra: 'alarme' },
  ];
  const CAMPOS_TEXTO = BLOCOS.map((b) => b.campo);
  const TEM_COLCHETES = /\[[^\]]*\]/;

  const $app = document.getElementById('app');
  const $busca = document.getElementById('busca');
  const $limpar = document.getElementById('btn-limpar');
  const $tema = document.getElementById('btn-tema');
  const $btnBackup = document.getElementById('btn-backup');

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

  function lerLista(chave) {
    const v = lerLS(chave, []);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  }

  let versoes = lerLS(LS_VERSOES, {});
  if (!versoes || typeof versoes !== 'object' || Array.isArray(versoes)) versoes = {};
  let favoritos = lerLista(LS_FAV);
  let recentes = lerLista(LS_REC);

  const agoraISO = () => new Date().toISOString();
  const unicos = (a) => [...new Set(a)];

  // salva (ou apaga, se o texto for igual ao original) a sua versão de um bloco
  function gravarVersao(id, campo, valor, orig) {
    const copia = JSON.parse(JSON.stringify(versoes));
    if (!copia[id] || typeof copia[id] !== 'object') copia[id] = {};
    if (valor === orig) delete copia[id][campo];
    else copia[id][campo] = { t: valor, b: orig };
    if (!Object.keys(copia[id]).length) delete copia[id];
    if (!gravarLS(LS_VERSOES, copia)) return false;
    versoes = copia;
    gravarLS(LS_ALTERADO, agoraISO());
    return true;
  }

  function alternarFavorito(id) {
    const nova = favoritos.slice();
    const i = nova.indexOf(id);
    if (i >= 0) nova.splice(i, 1); else nova.unshift(id);
    if (!gravarLS(LS_FAV, nova)) return false;
    favoritos = nova;
    return true;
  }

  function registrarRecente(id) {
    const nova = [id].concat(recentes.filter((x) => x !== id)).slice(0, MAX_RECENTES);
    if (gravarLS(LS_REC, nova)) recentes = nova;
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

  const dataHora = (iso) => {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleString('pt-BR');
  };

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
    const ehFav = (x) => (favoritos.includes(x.c.id) ? 1 : 0);
    res.sort((a, b) =>
      b.score - a.score || ehFav(b) - ehFav(a) || a.c.nome.localeCompare(b.c.nome, 'pt-BR'));
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

  // devolve true se copiou
  async function executarCopia(btn, rotulo, obterTexto, aoFalhar) {
    const txt = obterTexto();
    if (!txt.trim()) { piscar(btn, 'Texto vazio', rotulo, 'erro'); return false; }
    const ok = await copiarTexto(txt);
    if (ok) {
      piscar(btn, 'Copiado ✓', rotulo, 'ok');
      try { if (navigator.vibrate) navigator.vibrate(25); } catch (e) {}
    } else {
      piscar(btn, 'Não copiou. Copie manualmente', rotulo, 'erro', 3500);
      if (aoFalhar) aoFalhar();
    }
    return ok;
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

  /* ---------- lista, favoritos e recentes ---------- */

  function estrelaHTML(id, detalhe) {
    const on = favoritos.includes(id);
    return (
      '<button type="button" class="estrela' + (on ? ' on' : '') + '" data-id="' + esc(id) + '"' +
      (detalhe ? ' data-det="1"' : '') +
      ' aria-pressed="' + on + '" aria-label="' + (on ? 'Remover dos favoritos' : 'Adicionar aos favoritos') + '">' +
      (on ? '★' : '☆') + '</button>'
    );
  }

  function atualizarEstrela(btn, id) {
    const on = favoritos.includes(id);
    btn.classList.toggle('on', on);
    btn.textContent = on ? '★' : '☆';
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', on ? 'Remover dos favoritos' : 'Adicionar aos favoritos');
  }

  function itemHTML(c, campos, compacto) {
    const tags = compacto ? '' : (c.tags || []).map((t) => '<span class="tag">' + esc(t) + '</span>').join('');
    let via = '';
    if (!compacto && campos && consulta && !campos.has('nome') && !campos.has('cid')) {
      const nomes = [...campos].map((k) => ROTULO[k]).filter(Boolean);
      if (nomes.length) via = '<div class="via">encontrado em: ' + esc(nomes.join(', ')) + '</div>';
    }
    return (
      '<li class="linha"><a class="item' + (compacto ? ' compacto' : '') + '" href="#/c/' + encodeURIComponent(c.id) + '">' +
      '<div class="item-topo"><span class="item-nome">' + esc(c.nome) + '</span>' +
      (c.cid ? '<span class="item-cid">' + esc(c.cid) + '</span>' : '') + '</div>' +
      (tags ? '<div class="tags">' + tags + '</div>' : '') + via +
      '</a>' + estrelaHTML(c.id, false) + '</li>'
    );
  }

  function faixaBackup() {
    if (!Object.keys(versoes).length) return '';
    const ult = lerLS(LS_BACKUP, null);
    const alt = lerLS(LS_ALTERADO, null);
    if (ult && (!alt || ult >= alt)) return '';
    return '<a class="faixa" href="#/backup">💾 Você tem textos editados sem backup. Toque para fazer o backup.</a>';
  }

  function renderHome() {
    const todas = buscar('');
    if (!todas.length) {
      $app.innerHTML = '<div class="vazio"><p>Nenhuma condição no banco ainda.</p></div>';
      return;
    }
    const porId = new Map(condicoes.map((c) => [c.id, c]));
    const favs = favoritos.map((id) => porId.get(id)).filter(Boolean);
    const recs = recentes.map((id) => porId.get(id)).filter(Boolean).slice(0, MOSTRAR_RECENTES);
    let html = faixaBackup();
    if (favs.length) {
      html += '<h2 class="secao">★ Favoritos</h2><ul class="lista">' +
        favs.map((c) => itemHTML(c, null, true)).join('') + '</ul>';
    }
    if (recs.length) {
      html += '<h2 class="secao">Recentes</h2><ul class="lista">' +
        recs.map((c) => itemHTML(c, null, true)).join('') + '</ul>';
    }
    html += '<h2 class="secao">Todas as condições (' + todas.length + ')</h2><ul class="lista">' +
      todas.map((r) => itemHTML(r.c, r.campos, false)).join('') + '</ul>';
    $app.innerHTML = html;
  }

  function renderLista() {
    if (!norm(consulta)) { renderHome(); return; }
    const res = buscar(consulta);
    if (!res.length) {
      $app.innerHTML =
        '<div class="vazio"><p><strong>Nada encontrado</strong> para “' + esc(consulta) + '”.</p>' +
        '<p>Tente outra palavra, o sintoma ou o código CID.</p></div>';
      return;
    }
    $app.innerHTML =
      '<p class="contagem">' + res.length + (res.length === 1 ? ' condição' : ' condições') + '</p>' +
      '<ul class="lista">' + res.map((r) => itemHTML(r.c, r.campos, false)).join('') + '</ul>';
  }

  /* ---------- tela da condição ---------- */

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
    registrarRecente(c.id);
    estado = {};
    const tags = (c.tags || []).map((t) => '<span class="tag">' + esc(t) + '</span>').join('');
    $app.innerHTML =
      '<a class="voltar" href="#/">← Voltar</a>' +
      '<article class="cond">' +
      '<div class="titulo-cond"><h2>' + esc(c.nome) + '</h2>' + estrelaHTML(c.id, true) + '</div>' +
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

  /* ---------- backup ---------- */

  function montarBackup() {
    return {
      app: NOME_APP,
      formato: 1,
      exportado_em: agoraISO(),
      versoes,
      favoritos,
      recentes,
    };
  }

  function nomeArquivo() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return 'backup-receita-rapida-' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '.json';
  }

  function baixar(nome, conteudo) {
    const blob = new Blob([conteudo], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  function marcarBackup() { gravarLS(LS_BACKUP, agoraISO()); }

  function contarVersoes(v) {
    let n = 0;
    for (const id of Object.keys(v)) {
      if (v[id] && typeof v[id] === 'object') n += Object.keys(v[id]).length;
    }
    return n;
  }

  function resumoExport() {
    const ult = lerLS(LS_BACKUP, null);
    return (
      contarVersoes(versoes) + ' texto(s) editado(s) · ' + favoritos.length + ' favorito(s) · ' +
      (ult && dataHora(ult) ? 'último backup: ' + dataHora(ult) : 'nenhum backup feito ainda')
    );
  }

  function validarBackup(txt) {
    let o;
    try { o = JSON.parse(txt); } catch (e) { throw new Error('O texto não é um JSON válido.'); }
    if (!o || o.app !== NOME_APP) throw new Error('Este arquivo não é um backup do Receita Rápida Plantão.');
    if (o.formato !== 1) throw new Error('Versão de backup não suportada (formato ' + o.formato + ').');
    const v = {};
    let nVers = 0;
    if (o.versoes && typeof o.versoes === 'object' && !Array.isArray(o.versoes)) {
      for (const id of Object.keys(o.versoes)) {
        if (id === '__proto__' || id === 'constructor' || id === 'prototype') continue;
        const blocos = o.versoes[id];
        if (!blocos || typeof blocos !== 'object') continue;
        for (const campo of CAMPOS_TEXTO) {
          const r = blocos[campo];
          if (r && typeof r.t === 'string') {
            if (!v[id]) v[id] = {};
            v[id][campo] = { t: r.t, b: typeof r.b === 'string' ? r.b : '' };
            nVers++;
          }
        }
      }
    }
    const lista = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []);
    return {
      versoes: v,
      nVers,
      favoritos: lista(o.favoritos),
      recentes: lista(o.recentes),
      data: typeof o.exportado_em === 'string' ? o.exportado_em : null,
    };
  }

  // mescla o backup com o que já existe no aparelho
  function aplicarImport(p) {
    const novasV = JSON.parse(JSON.stringify(versoes));
    for (const id of Object.keys(p.versoes)) {
      const atual = novasV[id] && typeof novasV[id] === 'object' ? novasV[id] : {};
      novasV[id] = Object.assign({}, atual, p.versoes[id]);
    }
    const novosF = unicos(favoritos.concat(p.favoritos));
    const novosR = unicos(recentes.concat(p.recentes)).slice(0, MAX_RECENTES);
    if (!gravarLS(LS_VERSOES, novasV) || !gravarLS(LS_FAV, novosF) || !gravarLS(LS_REC, novosR)) return false;
    gravarLS(LS_ALTERADO, agoraISO());
    versoes = novasV;
    favoritos = novosF;
    recentes = novosR;
    return true;
  }

  function lerArquivo(f) {
    if (f.text) return f.text();
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.readAsText(f);
    });
  }

  function podeCompartilharArquivo() {
    try {
      const teste = new File(['{}'], 'x.json', { type: 'application/json' });
      return !!(navigator.share && navigator.canShare && navigator.canShare({ files: [teste] }));
    } catch (e) { return false; }
  }

  function renderBackup() {
    $app.innerHTML =
      '<a class="voltar" href="#/">← Voltar</a>' +
      '<h2>Backup</h2>' +
      '<p class="suave">Seus textos editados, favoritos e recentes ficam só neste navegador. ' +
      'Faça um backup de vez em quando e guarde o arquivo em um lugar seguro (Drive, e-mail, WhatsApp para você).</p>' +
      '<section class="bloco"><div class="bloco-topo"><h3>Exportar</h3></div>' +
      '<p class="suave" id="resumo-exp"></p>' +
      '<div class="acoes-col">' +
      '<button type="button" class="btn cheio" id="exp-baixar">Baixar arquivo de backup</button>' +
      '<button type="button" class="btn-sec cheio" id="exp-compartilhar" hidden>Compartilhar / salvar em…</button>' +
      '<button type="button" class="btn-sec cheio" id="exp-copiar">Copiar JSON</button>' +
      '</div></section>' +
      '<section class="bloco"><div class="bloco-topo"><h3>Importar</h3></div>' +
      '<p class="suave">Escolha um arquivo de backup. Ele será mesclado ao que já existe neste aparelho.</p>' +
      '<input type="file" id="imp-arquivo" accept=".json,application/json">' +
      '<p class="suave">Ou cole o conteúdo do backup aqui:</p>' +
      '<textarea class="campo" id="imp-texto" spellcheck="false" autocapitalize="off" autocorrect="off" ' +
      'aria-label="Colar backup"></textarea>' +
      '<button type="button" class="btn-sec cheio" id="imp-colado" style="margin-top:10px">Ler texto colado</button>' +
      '<div id="imp-resumo"></div></section>';

    const $resumoExp = document.getElementById('resumo-exp');
    const atualizarResumo = () => { $resumoExp.textContent = resumoExport(); };
    atualizarResumo();

    // exportar
    const btnBaixar = document.getElementById('exp-baixar');
    btnBaixar.addEventListener('click', () => {
      try {
        baixar(nomeArquivo(), JSON.stringify(montarBackup(), null, 2));
        marcarBackup();
        atualizarResumo();
        piscar(btnBaixar, 'Backup gerado ✓', 'Baixar arquivo de backup', 'ok');
      } catch (e) {
        piscar(btnBaixar, 'Falhou. Use "Copiar JSON"', 'Baixar arquivo de backup', 'erro', 3500);
      }
    });

    const btnShare = document.getElementById('exp-compartilhar');
    if (podeCompartilharArquivo()) {
      btnShare.hidden = false;
      btnShare.addEventListener('click', async () => {
        try {
          const arq = new File([JSON.stringify(montarBackup(), null, 2)], nomeArquivo(), { type: 'application/json' });
          await navigator.share({ files: [arq], title: 'Backup Receita Rápida Plantão' });
          marcarBackup();
          atualizarResumo();
          piscar(btnShare, 'Compartilhado ✓', 'Compartilhar / salvar em…', 'ok');
        } catch (e) {
          if (e && e.name === 'AbortError') return;
          piscar(btnShare, 'Falhou. Use "Copiar JSON"', 'Compartilhar / salvar em…', 'erro', 3500);
        }
      });
    }

    const btnCopiarJson = document.getElementById('exp-copiar');
    btnCopiarJson.addEventListener('click', async () => {
      const ok = await executarCopia(btnCopiarJson, 'Copiar JSON', () => JSON.stringify(montarBackup(), null, 2));
      if (ok) { marcarBackup(); atualizarResumo(); }
    });

    // importar
    const $resumoImp = document.getElementById('imp-resumo');
    let pendente = null;

    function mostrarPendente(txt) {
      try {
        pendente = validarBackup(txt);
      } catch (e) {
        pendente = null;
        $resumoImp.innerHTML = '<p class="erro-txt">' + esc(e.message) + '</p>';
        return;
      }
      const p = pendente;
      const quando = p.data && dataHora(p.data) ? ' de ' + esc(dataHora(p.data)) : '';
      $resumoImp.innerHTML =
        '<div class="resumo-import"><p><strong>Backup encontrado' + quando + '</strong><br>' +
        p.nVers + ' texto(s) editado(s), ' + p.favoritos.length + ' favorito(s), ' +
        p.recentes.length + ' recente(s).</p>' +
        '<p>Será <strong>mesclado</strong> ao que já existe aqui. Se o mesmo bloco já tiver uma versão sua, ' +
