(() => {
  'use strict';

  const URL_BANCO = 'data/condicoes.json';
  const URL_LOTES = 'data/lotes.json'; // { "arquivos": ["lote-01.json", ...] }
  const LS_PROPRIAS = 'rrp_proprias'; // condições criadas por você
  const LS_FAV = 'rrp_favoritos'; // [ids]
  const LS_REC = 'rrp_recentes'; // [ids]
  const LS_BACKUP = 'rrp_ultimo_backup'; // data ISO do último backup
  const LS_ALTERADO = 'rrp_alterado'; // data ISO da última mudança nos seus dados
  const MAX_RECENTES = 10;
  const MOSTRAR_RECENTES = 5;
  const NOME_APP = 'receita-rapida-plantao';

  // [campo do índice, peso na pontuação]
  const CAMPOS = [['nome', 5], ['cid', 5], ['sin', 4], ['sint', 2], ['tags', 1]];
  const ROTULO = { sin: 'sinônimo', sint: 'sintoma', tags: 'tag' };
  const BLOCOS = [
    { campo: 'prescricao_ps', titulo: 'Prescrição no PS / hospitalar', copiar: 'Copiar prescrição no PS', extra: '', naTudo: false },
    { campo: 'receita', titulo: 'Receita', copiar: 'Copiar receita', extra: '', naTudo: true },
    { campo: 'orientacoes', titulo: 'Orientações', copiar: 'Copiar orientações', extra: '', naTudo: true },
    { campo: 'sinais_alarme', titulo: 'Sinais de alarme', copiar: 'Copiar sinais de alarme', extra: 'alarme', naTudo: true },
  ];
  const TEM_COLCHETES = /\[[^\]]*\]/;

  const $app = document.getElementById('app');
  const $busca = document.getElementById('busca');
  const $limpar = document.getElementById('btn-limpar');
  const $tema = document.getElementById('btn-tema');
  const $btnBackup = document.getElementById('btn-backup');

  let base = []; // condições dos arquivos de dados
  let condicoes = []; // base + suas condições
  let indice = [];
  let pronto = false;
  let consulta = '';
  let scrollLista = 0;
  let abriuDaLista = false;
  let timer = null;
  let formInicial = null; // dados para pré-preencher o formulário (duplicar / nome sugerido)
  let falhasLotes = []; // lotes que não carregaram

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

  // limpa uma condição própria vinda do aparelho ou de um backup
  function sanearCondicao(o) {
    if (!o || typeof o !== 'object') return null;
    if (typeof o.id !== 'string' || !o.id.startsWith('usr-')) return null;
    if (typeof o.nome !== 'string' || !o.nome.trim()) return null;
    const s = (v) => (typeof v === 'string' ? v : Array.isArray(v) ? v.filter((x) => typeof x === 'string').join('\n') : '');
    const l = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
    return {
      id: o.id,
      nome: o.nome.trim(),
      cid: typeof o.cid === 'string' ? o.cid : '',
      tags: l(o.tags),
      sinonimos: l(o.sinonimos),
      sintomas: l(o.sintomas),
      prescricao_ps: s(o.prescricao_ps),
      receita: s(o.receita),
      orientacoes: s(o.orientacoes),
      sinais_alarme: s(o.sinais_alarme),
      revisado: o.revisado === true,
      propria: true,
    };
  }

  function carregarProprias() {
    const v = lerLS(LS_PROPRIAS, []);
    if (!Array.isArray(v)) return [];
    const vistos = new Set();
    return v.map(sanearCondicao).filter((c) => {
      if (!c || vistos.has(c.id)) return false;
      vistos.add(c.id);
      return true;
    });
  }

  let proprias = carregarProprias();
  let favoritos = lerLista(LS_FAV);
  let recentes = lerLista(LS_REC);

  const agoraISO = () => new Date().toISOString();
  const unicos = (a) => [...new Set(a)];

  function reconstruir() {
    const ids = new Set(base.map((c) => c.id));
    condicoes = base.concat(proprias.filter((c) => !ids.has(c.id)));
    indice = condicoes.map(construirIndice);
  }

  function excluirPropria(id) {
    const antes = proprias;
    proprias = proprias.filter((c) => c.id !== id);
    if (!gravarLS(LS_PROPRIAS, proprias)) {
      proprias = antes;
      alert('Não consegui excluir neste navegador.');
      return;
    }
    gravarLS(LS_ALTERADO, agoraISO());
    favoritos = favoritos.filter((x) => x !== id);
    gravarLS(LS_FAV, favoritos);
    recentes = recentes.filter((x) => x !== id);
    gravarLS(LS_REC, recentes);
    reconstruir();
    abriuDaLista = false;
    history.replaceState(null, '', '#/');
    rotear();
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

  // texto com os [campos] destacados
  const comDestaque = (t) =>
    esc(t).replace(
      /\[[^\]]*\]/g,
      (m) => '<mark style="background:var(--aviso-bg);color:var(--aviso-txt);border-radius:4px;padding:0 3px">' + m + '</mark>'
    );

  const selecionar = (el) => {
    try {
      const r = document.createRange();
      r.selectNodeContents(el);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    } catch (e) {}
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

  const textoBloco = (c, b) => texto(c[b.campo]).trim();

  // "Copiar tudo": receita + orientações + sinais de alarme (sem a prescrição no PS)
  function montarTudo(c) {
    return BLOCOS
      .filter((b) => b.naTudo)
      .map((b) => ({ t: b.titulo.toUpperCase(), v: textoBloco(c, b) }))
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
    let tags = compacto ? '' : (c.tags || []).map((t) => '<span class="tag">' + esc(t) + '</span>').join('');
    if (!compacto && c.propria) tags = '<span class="tag minha">Minha</span>' + tags;
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
    if (!proprias.length) return '';
    const ult = lerLS(LS_BACKUP, null);
    const alt = lerLS(LS_ALTERADO, null);
    if (ult && (!alt || ult >= alt)) return '';
    return '<a class="faixa" href="#/backup">💾 Você criou condições suas e ainda não fez backup. Toque para fazer o backup.</a>';
  }

  function faixaLotes() {
    if (!falhasLotes.length) return '';
    return '<p class="aviso-rev">⚠ Não consegui carregar: ' + esc(falhasLotes.join(', ')) +
      '. Confira os nomes em data/lotes.json e os arquivos na pasta data.</p>';
  }

  function renderHome() {
    const todas = buscar('');
    const botaoNova = '<a class="btn-sec cheio" href="#/nova" style="margin-bottom:6px">＋ Adicionar condição</a>';
    if (!todas.length) {
      $app.innerHTML = faixaLotes() + botaoNova + '<div class="vazio"><p>Nenhuma condição no banco ainda.</p></div>';
      return;
    }
    const porId = new Map(condicoes.map((c) => [c.id, c]));
    const favs = favoritos.map((id) => porId.get(id)).filter(Boolean);
    const recs = recentes.map((id) => porId.get(id)).filter(Boolean).slice(0, MOSTRAR_RECENTES);
    let html = faixaLotes() + faixaBackup() + botaoNova;
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
        '<p>Tente outra palavra, o sintoma ou o código CID.</p>' +
        '<a class="btn cheio btn-nova" href="#/nova" data-nome="' + esc(consulta.trim()) + '">' +
        '＋ Cadastrar “' + esc(consulta.trim()) + '” como nova condição</a></div>';
      return;
    }
    $app.innerHTML =
      '<p class="contagem">' + res.length + (res.length === 1 ? ' condição' : ' condições') + '</p>' +
      '<ul class="lista">' + res.map((r) => itemHTML(r.c, r.campos, false)).join('') + '</ul>';
  }

  /* ---------- tela da condição (somente leitura) ---------- */

  const ajustar = (ta) => {
    ta.style.height = 'auto';
    ta.style.height = (ta.scrollHeight + 2) + 'px';
  };

  function blocoHTML(c, b) {
    return (
      '<section class="bloco ' + b.extra + '">' +
      '<div class="bloco-topo"><h3>' + esc(b.titulo) + '</h3></div>' +
      '<div data-texto="' + b.campo + '" style="white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.55">' +
      comDestaque(textoBloco(c, b)) + '</div>' +
      '<button type="button" class="btn btn-copiar" data-copiar="' + b.campo + '">' + esc(b.copiar) + '</button>' +
      '</section>'
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
    registrarRecente(c.id);
    const blocosC = BLOCOS.filter((b) => textoBloco(c, b) !== '');
    const tudo = montarTudo(c);
    const tags =
      (c.propria ? '<span class="tag minha">Minha condição</span>' : '') +
      (c.tags || []).map((t) => '<span class="tag">' + esc(t) + '</span>').join('');
    $app.innerHTML =
      '<a class="voltar" href="#/">← Voltar</a>' +
      '<article class="cond">' +
      '<div class="titulo-cond"><h2>' + esc(c.nome) + '</h2>' + estrelaHTML(c.id, true) + '</div>' +
      '<div class="meta">' + (c.cid ? '<span>CID-10 ' + esc(c.cid) + '</span>' : '') + tags + '</div>' +
      (c.revisado === true ? '' : '<p class="aviso-rev">⚠ Conteúdo ainda não revisado por você. Confira antes de usar.</p>') +
      (c.nota_revisao
        ? '<details class="nota"><summary>Nota para revisão</summary><p>' + esc(texto(c.nota_revisao)) + '</p></details>'
        : '') +
      (blocosC.length
        ? blocosC.map((b) => blocoHTML(c, b)).join('')
        : '<div class="vazio"><p>Esta condição ainda não tem texto.</p></div>') +
      '<div class="acoes-col" style="margin-top:6px">' +
      (c.propria
        ? '<a class="btn-sec cheio" href="#/editar/' + encodeURIComponent(c.id) + '">Editar cadastro (nome, CID, busca)</a>'
        : '') +
      '<button type="button" class="btn-sec cheio" id="btn-duplicar">Duplicar como nova condição</button>' +
      (c.propria
        ? '<button type="button" class="btn-sec cheio perigo" id="btn-excluir">Excluir esta condição</button>'
        : '') +
      '</div>' +
      '</article>' +
      (tudo ? '<div class="barra-copiar"><button type="button" class="btn cheio" id="btn-tudo">Copiar tudo</button></div>' : '');

    blocosC.forEach((b) => {
      const btn = $app.querySelector('[data-copiar="' + b.campo + '"]');
      const area = $app.querySelector('[data-texto="' + b.campo + '"]');
      ligarBotao(btn, {
        rotulo: b.copiar,
        aviso: 'Tem [campos]. Copiar mesmo assim?',
        precisa: () => TEM_COLCHETES.test(textoBloco(c, b)),
        acao: (bt, rotulo) => executarCopia(bt, rotulo, () => textoBloco(c, b), () => selecionar(area)),
      });
    });

    if (tudo) {
      ligarBotao(document.getElementById('btn-tudo'), {
        rotulo: 'Copiar tudo',
        aviso: 'Tem [campos]. Copiar tudo mesmo assim?',
        precisa: () => TEM_COLCHETES.test(tudo),
        acao: (bt, rotulo) => executarCopia(bt, rotulo, () => tudo),
      });
    }

    document.getElementById('btn-duplicar').addEventListener('click', () => {
      formInicial = {
        nome: c.nome + ' (cópia)',
        cid: c.cid || '',
        tags: c.tags || [],
        sinonimos: c.sinonimos || [],
        sintomas: c.sintomas || [],
        prescricao_ps: texto(c.prescricao_ps),
        receita: texto(c.receita),
        orientacoes: texto(c.orientacoes),
        sinais_alarme: texto(c.sinais_alarme),
        revisado: c.revisado === true,
      };
      aoNavegar();
      location.hash = '#/nova';
    });

    if (c.propria) {
      ligarBotao(document.getElementById('btn-excluir'), {
        rotulo: 'Excluir esta condição',
        aviso: 'Toque de novo para EXCLUIR de vez',
        precisa: () => true,
        acao: () => excluirPropria(c.id),
      });
    }

    window.scrollTo(0, 0);
  }

  /* ---------- formulário: nova condição / editar cadastro ---------- */

  const listar = (s) => unicos(s.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean));

  function novoId(nome) {
    const slug = norm(nome).replace(/ /g, '-').slice(0, 40) || 'condicao';
    return 'usr-' + slug + '-' + Date.now().toString(36);
  }

  function renderForm(id) {
    const editando = id ? proprias.find((c) => c.id === id) : null;
    if (id && !editando) {
      $app.innerHTML =
        '<a class="voltar" href="#/">← Voltar</a>' +
        '<div class="vazio"><p>Só condições criadas por você podem ter o cadastro editado. ' +
        'Para mudar uma condição do banco, use “Duplicar como nova condição”.</p></div>';
      return;
    }
    const ini = editando || formInicial || {};
    formInicial = null;

    const entrada = (k, rot, dica, extra) =>
      '<div class="grupo"><label class="rotulo" for="' + k + '">' + rot + '</label>' +
      '<input class="entrada" id="' + k + '" type="text" autocomplete="off" spellcheck="false" ' + (extra || '') + '>' +
      (dica ? '<p class="dica">' + dica + '</p>' : '') + '</div>';
    const area = (k, rot, dica, curto) =>
      '<div class="grupo"><label class="rotulo" for="' + k + '">' + rot + '</label>' +
      '<textarea class="campo' + (curto ? ' curto' : '') + '" id="' + k + '" spellcheck="false" ' +
      'autocapitalize="off" autocorrect="off"></textarea>' +
      (dica ? '<p class="dica">' + dica + '</p>' : '') + '</div>';

    $app.innerHTML =
      '<a class="voltar" href="#/">← Voltar</a>' +
      '<h2>' + (editando ? 'Editar condição' : 'Nova condição') + '</h2>' +
      '<p class="suave">A busca procura por nome, sinônimos, sintomas, CID e tags. ' +
      'Nada é validado pelo app: confira doses e CID antes de usar.</p>' +
      '<div class="form">' +
      entrada('f-nome', 'Nome da condição *', '', 'autocapitalize="sentences"') +
      entrada('f-cid', 'CID-10', 'Digite o código que você conferiu (ex.: J03.0). O app não preenche sozinho.', 'autocapitalize="characters"') +
      entrada('f-tags', 'Tags', 'Separe por vírgula. Ex.: Respiratório, Pediatria', 'autocapitalize="sentences"') +
      area('f-sin', 'Sinônimos', 'Um por linha (ou separados por vírgula). Ex.: amigdalite, dor de garganta', true) +
      area('f-sint', 'Sintomas associados', 'Um por linha (ou separados por vírgula). Ex.: febre, odinofagia', true) +
      area('f-ps', 'Prescrição no PS / hospitalar (opcional)', 'Só aparece na condição se tiver texto. Não entra no «Copiar tudo».') +
      area('f-receita', 'Receita', 'Use [colchetes] para o que precisa ser preenchido ou apagado antes de copiar. Ex.: [peso] kg') +
      area('f-orient', 'Orientações ao paciente', '') +
      area('f-alarme', 'Sinais de alarme', '') +
      '<div class="grupo"><label class="check"><input type="checkbox" id="f-rev"> Conteúdo revisado por mim</label>' +
      '<p class="dica">Se desmarcado, a condição mostra o aviso “ainda não revisado”.</p></div>' +
      '<p class="erro-txt" id="f-erro" hidden></p>' +
      '</div>' +
      '<div class="barra-copiar"><div class="barra-dupla">' +
      '<button type="button" class="btn-sec" id="f-cancelar">Cancelar</button>' +
      '<button type="button" class="btn" id="f-salvar">Salvar</button>' +
      '</div></div>';

    const $ = (k) => document.getElementById(k);
    $('f-nome').value = ini.nome || '';
    $('f-cid').value = ini.cid || '';
    $('f-tags').value = (ini.tags || []).join(', ');
    $('f-sin').value = (ini.sinonimos || []).join('\n');
    $('f-sint').value = (ini.sintomas || []).join('\n');
    $('f-ps').value = texto(ini.prescricao_ps);
    $('f-receita').value = texto(ini.receita);
    $('f-orient').value = texto(ini.orientacoes);
    $('f-alarme').value = texto(ini.sinais_alarme);
    $('f-rev').checked = editando ? editando.revisado === true : ini.revisado !== false;

    const areas = ['f-sin', 'f-sint', 'f-ps', 'f-receita', 'f-orient', 'f-alarme'];
    areas.forEach((k) => {
      const ta = $(k);
      ta.addEventListener('input', () => ajustar(ta));
      ajustar(ta);
    });
    requestAnimationFrame(() => areas.forEach((k) => ajustar($(k))));

    $('f-cancelar').addEventListener('click', () => {
      if (abriuDaLista) { abriuDaLista = false; history.back(); }
      else { location.hash = '#/'; }
    });

    $('f-salvar').addEventListener('click', () => {
      const nome = $('f-nome').value.trim();
      const $erro = $('f-erro');
      if (!nome) {
        $erro.textContent = 'Informe o nome da condição.';
        $erro.hidden = false;
        $('f-nome').focus();
        return;
      }
      $erro.hidden = true;
      const dados = {
        nome,
        cid: $('f-cid').value.trim(),
        tags: listar($('f-tags').value),
        sinonimos: listar($('f-sin').value),
        sintomas: listar($('f-sint').value),
        prescricao_ps: $('f-ps').value.trim(),
        receita: $('f-receita').value.trim(),
        orientacoes: $('f-orient').value.trim(),
        sinais_alarme: $('f-alarme').value.trim(),
        revisado: $('f-rev').checked,
      };
      const antes = JSON.parse(JSON.stringify(proprias));
      let alvo;
      if (editando) {
        Object.assign(editando, dados);
        alvo = editando;
      } else {
        alvo = Object.assign({ id: novoId(nome), propria: true }, dados);
        proprias.push(alvo);
      }
      if (!gravarLS(LS_PROPRIAS, proprias)) {
        proprias = antes;
        reconstruir();
        alert('Não consegui salvar neste navegador (modo anônimo ou armazenamento bloqueado).');
        return;
      }
      gravarLS(LS_ALTERADO, agoraISO());
      reconstruir();
      abriuDaLista = false;
      history.replaceState(null, '', '#/c/' + encodeURIComponent(alvo.id));
      rotear();
    });

    window.scrollTo(0, 0);
    if (!$('f-nome').value) $('f-nome').focus();
  }

  /* ---------- backup ---------- */

  function montarBackup() {
    return {
      app: NOME_APP,
      formato: 1,
      exportado_em: agoraISO(),
      condicoes_proprias: proprias,
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

  function resumoExport() {
    const ult = lerLS(LS_BACKUP, null);
    return (
      proprias.length + ' condição(ões) própria(s) · ' + favoritos.length + ' favorito(s) · ' +
      (ult && dataHora(ult) ? 'último backup: ' + dataHora(ult) : 'nenhum backup feito ainda')
    );
  }

  function validarBackup(txt) {
    let o;
    try { o = JSON.parse(txt); } catch (e) { throw new Error('O texto não é um JSON válido.'); }
    if (!o || o.app !== NOME_APP) throw new Error('Este arquivo não é um backup do Receita Rápida Plantão.');
    if (o.formato !== 1) throw new Error('Versão de backup não suportada (formato ' + o.formato + ').');
    const vistos = new Set();
    const ps = (Array.isArray(o.condicoes_proprias) ? o.condicoes_proprias : [])
      .map(sanearCondicao)
      .filter((c) => {
        if (!c || vistos.has(c.id)) return false;
        vistos.add(c.id);
        return true;
      });
    const lista = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []);
    return {
      proprias: ps,
      favoritos: lista(o.favoritos),
      recentes: lista(o.recentes),
      data: typeof o.exportado_em === 'string' ? o.exportado_em : null,
    };
  }

  // mescla o backup com o que já existe no aparelho
  function aplicarImport(p) {
    const novasP = proprias.slice();
    for (const c of p.proprias) {
      const i = novasP.findIndex((x) => x.id === c.id);
      if (i >= 0) novasP[i] = c; else novasP.push(c);
    }
    const novosF = unicos(favoritos.concat(p.favoritos));
    const novosR = unicos(recentes.concat(p.recentes)).slice(0, MAX_RECENTES);
    if (!gravarLS(LS_PROPRIAS, novasP) || !gravarLS(LS_FAV, novosF) || !gravarLS(LS_REC, novosR)) return false;
    gravarLS(LS_ALTERADO, agoraISO());
    proprias = novasP;
    favoritos = novosF;
    recentes = novosR;
    reconstruir();
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
      '<p class="suave">Suas condições criadas, favoritos e recentes ficam só neste navegador. ' +
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
        p.proprias.length + ' condição(ões) própria(s), ' +
        p.favoritos.length + ' favorito(s), ' + p.recentes.length + ' recente(s).</p>' +
        '<p>Será <strong>mesclado</strong> ao que já existe aqui. Se a mesma condição já existir, ' +
        'vale a do arquivo.</p>' +
        '<button type="button" class="btn cheio" id="imp-confirmar">Confirmar importação</button></div>';
      document.getElementById('imp-confirmar').addEventListener('click', () => {
        if (pendente && aplicarImport(pendente)) {
          pendente = null;
          $resumoImp.innerHTML = '<p class="ok-txt">Importado ✓</p>';
          atualizarResumo();
        } else {
          $resumoImp.innerHTML = '<p class="erro-txt">Não consegui gravar neste navegador.</p>';
        }
      });
    }

    const $arq = document.getElementById('imp-arquivo');
    $arq.addEventListener('change', async () => {
      const f = $arq.files && $arq.files[0];
      if (!f) return;
      try {
        mostrarPendente(await lerArquivo(f));
      } catch (e) {
        $resumoImp.innerHTML = '<p class="erro-txt">Não consegui ler o arquivo.</p>';
      }
      $arq.value = '';
    });

    document.getElementById('imp-colado').addEventListener('click', () => {
      const txt = document.getElementById('imp-texto').value.trim();
      if (!txt) { $resumoImp.innerHTML = '<p class="erro-txt">Cole o conteúdo do backup primeiro.</p>'; return; }
      mostrarPendente(txt);
    });

    window.scrollTo(0, 0);
  }

  /* ---------- erro ---------- */

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

  function decodificar(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  function rotear() {
    if (!pronto) return;
    const h = location.hash || '#/';
    const mc = h.match(/^#\/c\/(.+)$/);
    const me = h.match(/^#\/editar\/(.+)$/);
    if (h === '#/backup') {
      renderBackup();
    } else if (h === '#/nova') {
      renderForm(null);
    } else if (me) {
      renderForm(decodificar(me[1]));
    } else if (mc) {
      renderCondicao(decodificar(mc[1]));
    } else {
      renderLista();
      window.scrollTo(0, scrollLista);
      scrollLista = 0;
    }
  }

  // chamado ao ir para uma tela "mais funda" (para o botão Voltar funcionar bem)
  function aoNavegar() {
    const h = location.hash || '#/';
    if (h === '#/' || h === '#') scrollLista = window.scrollY;
    abriuDaLista = true;
  }

  $app.addEventListener('click', (e) => {
    const est = e.target.closest('.estrela');
    if (est) {
      e.preventDefault();
      const id = est.dataset.id;
      if (!alternarFavorito(id)) {
        alert('Não consegui salvar o favorito neste navegador.');
        return;
      }
      if (est.dataset.det) {
        atualizarEstrela(est, id);
      } else {
        const y = window.scrollY;
        renderLista();
        window.scrollTo(0, y);
      }
      return;
    }
    if (e.target.closest('.voltar')) {
      e.preventDefault();
      if (abriuDaLista) { abriuDaLista = false; history.back(); }
      else { location.hash = '#/'; }
      return;
    }
    const a = e.target.closest('a[href^="#/"]');
    if (a) {
      if (a.classList.contains('btn-nova')) {
        formInicial = a.dataset.nome ? { nome: a.dataset.nome } : null;
      }
      aoNavegar();
    }
  });

  $btnBackup.addEventListener('click', () => {
    if ((location.hash || '#/') === '#/backup') return;
    aoNavegar();
  });

  /* ---------- busca na tela ---------- */

  function aoDigitar() {
    consulta = $busca.value;
    $limpar.hidden = !consulta;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const h = location.hash || '#/';
      if (h !== '#/' && h !== '#') {
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

  async function buscarJSON(url) {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error('Arquivo ' + url + ' não encontrado (HTTP ' + r.status + ').');
    return r.json();
  }

  async function carregar() {
    $app.innerHTML = '<p class="carregando">Carregando…</p>';
    try {
      const dados = await buscarJSON(URL_BANCO);
      if (!dados || !Array.isArray(dados.condicoes)) {
        throw new Error('Formato inválido: falta a lista "condicoes" no JSON.');
      }
      let todas = dados.condicoes.slice();

      // lotes extras (opcional): data/lotes.json -> { "arquivos": ["lote-01.json", ...] }
      falhasLotes = [];
      let arquivos = [];
      try {
        const l = await buscarJSON(URL_LOTES);
        if (l && Array.isArray(l.arquivos)) {
          arquivos = l.arquivos.filter((x) => typeof x === 'string' && /^[A-Za-z0-9._-]+\.json$/.test(x));
        }
      } catch (e) {
        if (!/não encontrado/.test(String(e && e.message))) falhasLotes.push('lotes.json');
      }
      for (const nome of arquivos) {
        try {
          const d = await buscarJSON('data/' + nome);
          if (!d || !Array.isArray(d.condicoes)) throw new Error('formato inválido');
          todas = todas.concat(d.condicoes);
        } catch (e) {
          falhasLotes.push(nome);
        }
      }

      const vistos = new Set();
      base = todas.filter((c) => {
        if (!c || !c.id || !c.nome) { console.warn('Condição ignorada (sem id ou nome):', c); return false; }
        if (vistos.has(c.id)) { console.warn('id repetido, ignorado:', c.id); return false; }
        vistos.add(c.id);
        return true;
      });
      reconstruir();
      pronto = true;
      rotear();
    } catch (e) {
      mostrarErro(e);
    }
  }

  carregar();
})();
