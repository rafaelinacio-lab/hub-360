// Escolhe o visual da interface: "v2" (padrão, Hub 360 2.0) ou "v1" (clássico).
// Troca por ?ui=v1 / ?ui=v2 na URL ou pelo botão do topo; a escolha fica em localStorage ('hubUI')
// e é repassada às abas (iframes) pelo evento 'storage'.
(function () {
    var root = document.documentElement;
    try {
        var q = new URLSearchParams(location.search).get('ui');
        if (q === 'v1' || q === 'v2') localStorage.setItem('hubUI', q);
    } catch (e) {}
    function atual() {
        try { return localStorage.getItem('hubUI') === 'v1' ? 'v1' : 'v2'; } catch (e) { return 'v2'; }
    }
    root.setAttribute('data-ui', atual());
    window.addEventListener('storage', function (e) {
        if (e.key === 'hubUI') root.setAttribute('data-ui', e.newValue === 'v1' ? 'v1' : 'v2');
    });
    window.hubAlternarVisual = function () {
        var prox = atual() === 'v2' ? 'v1' : 'v2';
        try { localStorage.setItem('hubUI', prox); } catch (e) {}
        root.setAttribute('data-ui', prox);
        return prox;
    };
})();
