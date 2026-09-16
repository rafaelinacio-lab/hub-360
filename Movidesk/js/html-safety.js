/* Encode for the actual sink: HTML text/attributes or a JavaScript argument in HTML. */
function hubEscapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
}
function hubJsArg(value) { return hubEscapeHtml(JSON.stringify(value ?? null)); }
