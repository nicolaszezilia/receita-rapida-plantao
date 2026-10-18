(() => {
  'use strict';

  const URL_BANCO = 'data/condicoes.json';
  const LS_VERSOES = 'rrp_versoes'; // { idDaCondicao: { campo: { t: texto, b: original } } }
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

  let base = []; // condições do arquivo condicoes.json
  let condicoes = []; // base + suas condições
  let indice = [];
  let pronto = false;
  let consulta = '';
  let scrollLista = 0;
  let abriuDaLista = false;
  let timer = null;
  let estado = {}; // estado dos 3 blocos da condição aberta
  let formInicial = null; // dados para pré-preencher o formulário (duplicar / nome sugerido)

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

  let versoes = lerLS(LS_VERSOES, {});
  if (!versoes || typeof versoes !== 'object' || Array.isArray(versoes)) versoes = {};
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

  // numa condição própria, salvar altera a própria condição
  function salvarCampoPropria(c, campo, valor) {
    const antes = c[campo];
    c[campo] = valor;
    if (!gravarLS(LS_PROPRIAS, proprias)) { c[campo] = antes; return false; }
    gravarLS(LS_ALTERADO, agoraISO());
    return true;
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
