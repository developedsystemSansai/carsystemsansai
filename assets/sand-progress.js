/*! SAND Sansai — <sand-progress> v1.0.0
 *  Attributes: label, value, max, variant(primary|success|warning|danger|purple),
 *              size(sm|md|lg), detail, show-value, animated
 *  ไม่พึ่ง framework — ถ้ามี sand-ui.js ที่ประกาศ <sand-progress> อยู่แล้ว ไฟล์นี้จะไม่ประกาศซ้ำ
 */
(function () {
  if (!window.customElements || customElements.get('sand-progress')) return;

  var COLORS = {
    primary: ['#1d6fb5', '#3b8fd6'],
    success: ['#157a40', '#22b563'],
    warning: ['#c9820a', '#f0b429'],
    danger : ['#c0392b', '#e5564a'],
    purple : ['#6d3fc0', '#8255d4']
  };
  var HEIGHT = { sm: 6, md: 10, lg: 14 };

  var CSS =
    ':host{display:block;font-family:inherit}' +
    '.top{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:6px}' +
    '.label{font-size:13px;font-weight:700;color:var(--sand-text,#182332)}' +
    '.val{font-size:13px;font-weight:800;font-variant-numeric:tabular-nums;color:var(--sand-text,#182332)}' +
    '.track{position:relative;width:100%;background:#e4eaf3;border-radius:999px;overflow:hidden}' +
    '.bar{height:100%;width:0;border-radius:999px;transition:width .6s cubic-bezier(.22,.8,.3,1),background .3s}' +
    ':host([animated]) .bar{background-image:linear-gradient(45deg,rgba(255,255,255,.25) 25%,transparent 25%,transparent 50%,rgba(255,255,255,.25) 50%,rgba(255,255,255,.25) 75%,transparent 75%);background-size:16px 16px;animation:stripe 1s linear infinite}' +
    '@keyframes stripe{to{background-position:16px 0}}' +
    '.detail{margin-top:5px;font-size:11.5px;color:var(--sand-muted,#566b82)}' +
    '@media(prefers-reduced-motion:reduce){.bar{transition:none}:host([animated]) .bar{animation:none}}';

  function num(v, d) { var n = parseFloat(v); return isFinite(n) ? n : d; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  class SandProgress extends HTMLElement {
    static get observedAttributes() { return ['label', 'value', 'max', 'variant', 'size', 'detail', 'show-value']; }
    constructor() {
      super();
      this._root = this.attachShadow({ mode: 'open' });
      this._root.innerHTML =
        '<style>' + CSS + '</style>' +
        '<div class="top"><span class="label"></span><span class="val"></span></div>' +
        '<div class="track" role="progressbar" aria-valuemin="0"><div class="bar"></div></div>' +
        '<div class="detail"></div>';
      this._q = function (s) { return this._root.querySelector(s); };
    }
    connectedCallback() { this._render(); }
    attributeChangedCallback() { if (this.isConnected) this._render(); }
    _render() {
      var max = Math.max(num(this.getAttribute('max'), 100), 0.0001);
      var val = Math.min(Math.max(num(this.getAttribute('value'), 0), 0), max);
      var pct = Math.round((val / max) * 100);
      var variant = COLORS[this.getAttribute('variant')] ? this.getAttribute('variant') : 'primary';
      var c = COLORS[variant];
      var h = HEIGHT[this.getAttribute('size')] || HEIGHT.md;
      var label = this.getAttribute('label') || '';
      var detail = this.getAttribute('detail') || '';

      var q = this._q.bind(this);
      q('.label').textContent = label;
      q('.val').textContent = this.hasAttribute('show-value') ? pct + '%' : '';
      q('.top').style.display = (label || this.hasAttribute('show-value')) ? 'flex' : 'none';
      var track = q('.track');
      track.style.height = h + 'px';
      track.setAttribute('aria-valuemax', String(max));
      track.setAttribute('aria-valuenow', String(val));
      if (label) track.setAttribute('aria-label', label);
      var bar = q('.bar');
      bar.style.backgroundColor = c[0];
      bar.style.backgroundImage = this.hasAttribute('animated') ? '' : 'linear-gradient(90deg,' + c[0] + ',' + c[1] + ')';
      // ให้ transition ทำงานตั้งแต่ครั้งแรก
      requestAnimationFrame(function () { bar.style.width = pct + '%'; });
      var d = q('.detail');
      d.textContent = detail;
      d.style.display = detail ? 'block' : 'none';
    }
  }
  customElements.define('sand-progress', SandProgress);
})();
