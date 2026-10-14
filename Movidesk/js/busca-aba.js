// Busca "nesta aba" (Ctrl+K do shell → "Buscar nesta aba: …"). O shell manda { tipo: 'hub360:buscar', texto } para a página embutida.
// Aqui: 1) se a página tem o próprio campo de busca, preenche e dispara a busca dela; 2) se a página só embrulha outra (iframe), repassa;
// 3) sem campo nenhum, filtra as linhas das tabelas pelo texto. Texto vazio limpa a busca.
(function () {
  var CAMPOS = ['#listagem-search', '#filterBusca', '#fBusca', '#gCliente'];
  var norm = function (s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); };
  function campo() {
    for (var i = 0; i < CAMPOS.length; i++) { var el = document.querySelector(CAMPOS[i]); if (el) return el; }
    return null;
  }
  function filtrarTabelas(txt) {
    var q = norm(txt).trim();
    document.querySelectorAll('table tbody tr').forEach(function (tr) {
      if (!q) { if (tr.dataset.buscaOculta) { tr.style.display = ''; delete tr.dataset.buscaOculta; } return; }
      var ok = norm(tr.textContent).indexOf(q) >= 0;
      if (ok) { if (tr.dataset.buscaOculta) { tr.style.display = ''; delete tr.dataset.buscaOculta; } }
      else { tr.style.display = 'none'; tr.dataset.buscaOculta = '1'; }
    });
  }
  window.addEventListener('message', function (ev) {
    if (ev.origin !== location.origin || !ev.data || ev.data.tipo !== 'hub360:buscar') return;
    var txt = String(ev.data.texto || '');
    var el = campo();
    if (el) {
      el.value = txt;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); if (txt) el.focus({ preventScroll: true }); } catch (_) {}
      return;
    }
    var frames = document.querySelectorAll('iframe');
    if (frames.length) {
      frames.forEach(function (f) { try { f.contentWindow.postMessage(ev.data, location.origin); } catch (_) {} });
      return;
    }
    filtrarTabelas(txt);
  });
})();
