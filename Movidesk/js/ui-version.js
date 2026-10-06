// Visual 2.0 é o padrão do Hub 360: marca o <html> para ativar css/v2.css e css/sem-animacao.css.
document.documentElement.setAttribute('data-ui', 'v2');

// Gráficos (Chart.js) sem animação: assim que a biblioteca é carregada, desliga as animações padrão.
(function () {
    var guardado;
    try {
        Object.defineProperty(window, 'Chart', {
            configurable: true,
            get: function () { return guardado; },
            set: function (v) {
                guardado = v;
                try { if (v && v.defaults) { v.defaults.animation = false; v.defaults.transitions = { active: { animation: { duration: 0 } } }; } } catch (e) {}
            }
        });
    } catch (e) {}
})();
