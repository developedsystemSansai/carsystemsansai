/* SAND Sansai UI Kit — framework-free reusable components */
(function (window, document) {
  'use strict';
  const ASSET = 'assets/';
  const clamp = (n,min,max) => Math.min(max,Math.max(min,n));

  class SandProgress extends HTMLElement {
    static get observedAttributes(){ return ['value','max','label','detail','variant','size','show-value','animated']; }
    constructor(){ super(); this.attachShadow({mode:'open'}); }
    connectedCallback(){ this.render(); }
    attributeChangedCallback(){ if(this.isConnected) this.render(); }
    render(){
      const max = Math.max(0.0001, Number(this.getAttribute('max') || 100));
      const value = clamp(Number(this.getAttribute('value') || 0),0,max);
      const pct = Math.round(value/max*1000)/10;
      const label = this.getAttribute('label') || '';
      const detail = this.getAttribute('detail') || '';
      const variant = ['primary','purple','success','warning','danger'].includes(this.getAttribute('variant')) ? this.getAttribute('variant') : 'primary';
      const size = ['sm','md','lg'].includes(this.getAttribute('size')) ? this.getAttribute('size') : 'md';
      const show = this.hasAttribute('show-value');
      const animated = this.hasAttribute('animated');
      this.setAttribute('role','progressbar'); this.setAttribute('aria-valuemin','0'); this.setAttribute('aria-valuemax',String(max)); this.setAttribute('aria-valuenow',String(value));
      this.shadowRoot.innerHTML = `<style>:host{display:block;font:inherit;color:var(--sand-text,#18263d)}.head,.meta{display:flex;justify-content:space-between;align-items:center;gap:12px}.label{font-size:.9rem;font-weight:650;color:var(--sand-navy,#142d59)}.value{font-size:.9rem;font-weight:750;color:var(--sand-navy,#142d59);font-variant-numeric:tabular-nums;white-space:nowrap}.track{height:${size==='sm'?6:size==='lg'?14:10}px;margin-top:${size==='sm'?6:9}px;background:#e9eef6;border-radius:999px;overflow:hidden}.bar{height:100%;width:${pct}%;border-radius:inherit;position:relative;transition:width .65s cubic-bezier(.2,.8,.2,1);background:${({primary:'#2563eb',purple:'#7650b8',success:'#16834a',warning:'#e3a008',danger:'#c93636'})[variant]}}.bar.animated:after{content:'';position:absolute;inset:0;background:linear-gradient(105deg,transparent 25%,#ffffff66 50%,transparent 75%);transform:translateX(-100%);animation:shine 2.4s infinite}@keyframes shine{to{transform:translateX(100%)}}.meta{margin-top:7px;color:var(--sand-muted,#687891);font-size:.75rem}</style><div class="head">${label?`<span class="label">${this.escape(label)}</span>`:''}${show?`<span class="value">${pct}%</span>`:''}</div><div class="track"><div class="bar ${animated?'animated':''}"></div></div>${detail?`<div class="meta"><span>${this.escape(detail)}</span><span>${value} / ${max}</span></div>`:''}`;
    }
    escape(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  }
  class SandStatus extends HTMLElement {
    static get observedAttributes(){return ['label','tone'];}
    constructor(){super();this.attachShadow({mode:'open'});}
    connectedCallback(){this.render();} attributeChangedCallback(){if(this.isConnected)this.render();}
    render(){const tone=['success','warning','danger','info','neutral'].includes(this.getAttribute('tone'))?this.getAttribute('tone'):'neutral';const label=this.getAttribute('label')||this.textContent.trim();this.shadowRoot.innerHTML=`<style>:host{display:inline-block}.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font:inherit;font-size:.75rem;font-weight:700;line-height:1.5;white-space:nowrap}.pill:before{content:'';width:7px;height:7px;border-radius:50%;background:currentColor}.success{color:#16834a;background:#e8f6ee}.warning{color:#a66b00;background:#fff5df}.danger{color:#c93636;background:#fff0f0}.info{color:#2563eb;background:#eaf1ff}.neutral{color:#687891;background:#eef1f5}</style><span class="pill ${tone}">${String(label).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}</span>`;}
  }
  class SandSummaryCard extends HTMLElement {
    static get observedAttributes(){return ['title','value','detail','icon'];}
    constructor(){super();this.attachShadow({mode:'open'});}
    connectedCallback(){this.render();} attributeChangedCallback(){if(this.isConnected)this.render();}
    render(){const esc=s=>String(s).replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));const title=esc(this.getAttribute('title')||'');const value=esc(this.getAttribute('value')||'');const detail=esc(this.getAttribute('detail')||'');const icon=esc(this.getAttribute('icon')||'•');this.shadowRoot.innerHTML=`<style>:host{display:block}.card{background:var(--sand-surface,#fff);border:1px solid var(--sand-border,#dfe6f0);border-radius:14px;padding:16px;box-shadow:var(--sand-shadow,0 5px 20px #142d5917);font:inherit}.head{display:flex;justify-content:space-between;align-items:center;gap:8px;color:var(--sand-navy,#142d59);font-weight:750;font-size:.9rem}.icon{width:36px;height:36px;display:grid;place-items:center;border-radius:11px;background:#eaf1ff;font-size:18px}.value{margin-top:12px;color:var(--sand-navy,#142d59);font-size:1.8rem;font-weight:850;line-height:1.2;font-variant-numeric:tabular-nums}.detail{margin-top:5px;color:var(--sand-muted,#687891);font-size:.76rem}</style><article class="card"><div class="head"><span>${title}</span><span class="icon">${icon}</span></div><div class="value">${value}</div>${detail?`<div class="detail">${detail}</div>`:''}<slot></slot></article>`;}
  }

  class SandMascotProgress extends HTMLElement {
    static get observedAttributes(){ return ['value','max','label','detail','variant','mascot-size','show-value','show-percent','animated','segments','unit']; }
    constructor(){ super(); this.attachShadow({mode:'open'}); }
    connectedCallback(){ this.render(); }
    attributeChangedCallback(){ if(this.isConnected) this.render(); }
    escape(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    render(){
      const rawMax=Number(this.getAttribute('max')||100);
      const max=Number.isFinite(rawMax)&&rawMax>0?rawMax:100;
      const rawValue=Number(this.getAttribute('value')||0);
      const value=clamp(Number.isFinite(rawValue)?rawValue:0,0,max);
      const pct=Math.round(value/max*1000)/10;
      const label=this.escape(this.getAttribute('label')||'');
      const detail=this.escape(this.getAttribute('detail')||'');
      const variant=['primary','purple','success','warning','danger'].includes(this.getAttribute('variant'))?this.getAttribute('variant'):'primary';
      const mascotSize=clamp(Number(this.getAttribute('mascot-size')||54),36,84);
      const showValue=this.hasAttribute('show-value')||this.hasAttribute('show-percent');
      const animated=this.hasAttribute('animated');
      const complete=pct>=100;
      // segments="N" → แสดงเป็นช่องแยก N ช่อง (1 ช่อง = 1 หน่วย เช่น 1 คัน) แทนแท่งยาวต่อเนื่อง
      const rawSeg=Number(this.getAttribute('segments')||0);
      const segs=Number.isFinite(rawSeg)&&rawSeg>=2&&rawSeg<=40?Math.floor(rawSeg):0;
      const filled=segs?Math.round(value/max*segs):0;
      const runPct=segs?Math.round(filled/segs*1000)/10:pct;
      const unit=this.escape(this.getAttribute('unit')||'');
      const color=({primary:'#2563eb',purple:'#7650b8',success:'#16834a',warning:'#e3a008',danger:'#c93636'})[variant];
      const segHtml=segs?`<div class="segs">${Array.from({length:segs},(_,i)=>`<i class="seg${i<filled?' on':''}${animated&&filled<segs&&i===filled?' next':''}"></i>`).join('')}</div>`:'';
      const headVal=segs?`${value} / ${max}${unit?' '+unit:''}`:`${pct}%`;
      this.setAttribute('role','progressbar'); this.setAttribute('aria-label',this.getAttribute('label')||'ความคืบหน้า');
      this.setAttribute('aria-valuemin','0'); this.setAttribute('aria-valuemax',String(max)); this.setAttribute('aria-valuenow',String(value));
      this.shadowRoot.innerHTML=`<style>
        :host{display:block;min-width:0;color:var(--sand-text,#18263d);font:inherit}
        .head,.meta{display:flex;align-items:center;justify-content:space-between;gap:10px}
        .label{font-size:.9rem;font-weight:700;color:var(--sand-navy,#142d59)}
        .value{font-size:.9rem;font-weight:800;color:var(--sand-navy,#142d59);font-variant-numeric:tabular-nums;white-space:nowrap}
        .stage{height:${mascotSize+12}px;position:relative;margin-top:2px}
        .track{position:absolute;left:0;right:0;bottom:7px;height:9px;border-radius:99px;background:#e9eef6;overflow:hidden}
        .bar{height:100%;width:${pct}%;border-radius:inherit;transition:width .65s cubic-bezier(.2,.8,.2,1);background:${({primary:'#2563eb',purple:'#7650b8',success:'#16834a',warning:'#e3a008',danger:'#c93636'})[variant]};position:relative}
        .bar.animated:after{content:'';position:absolute;inset:0;background:linear-gradient(105deg,transparent 25%,#ffffff66 50%,transparent 75%);transform:translateX(-100%);animation:shine 2.4s infinite}
        .runner{position:absolute;bottom:9px;left:clamp(0px,calc(${runPct}% - ${mascotSize/2}px),calc(100% - ${mascotSize}px));width:${mascotSize}px;height:${mascotSize}px;object-fit:contain;transition:left .65s cubic-bezier(.2,.8,.2,1);filter:drop-shadow(0 2px 2px #142d5920);pointer-events:none}
        .finish{position:absolute;right:0;bottom:0;width:2px;height:17px;border-radius:2px;background:#b9c5d8}
        .segs{position:absolute;left:0;right:0;bottom:6px;height:11px;display:flex;gap:4px}
        .seg{flex:1;min-width:0;border-radius:99px;background:#e9eef6;transition:background .35s}
        .seg.on{background:${color}}
        .seg.next{background:${color}33;animation:blink 1.5s ease-in-out infinite}
        @keyframes blink{50%{background:${color}73}}
        .meta{margin-top:2px;color:var(--sand-muted,#687891);font-size:.75rem;flex-wrap:wrap}
        .done{color:var(--sand-success,#16834a);font-weight:750}
        @keyframes shine{to{transform:translateX(100%)}}
        @media(prefers-reduced-motion:reduce){.bar,.runner,.seg{transition:none}.bar.animated:after,.seg.next{animation:none}}
      </style>
      <div class="head">${label?`<span class="label">${label}</span>`:'<span></span>'}${showValue?`<span class="value">${headVal}</span>`:''}</div>
      <div class="stage">${segs?segHtml:`<div class="track"><div class="bar ${animated?'animated':''}"></div></div><span class="finish" aria-hidden="true"></span>`}<picture><source media="(prefers-reduced-motion: reduce)" srcset="${ASSET}sand-mascot-run-static.png"><img class="runner" src="${ASSET}sand-mascot-run.gif" alt="มาสคอต SAND กำลังพาความคืบหน้า" draggable="false"></picture></div>
      ${(detail||complete)?`<div class="meta"><span>${detail}</span><span class="${complete?'done':''}">${complete?'✓ เสร็จสมบูรณ์':(segs?'':`${value} / ${max}`)}</span></div>`:''}`;
    }
  }

  if(!customElements.get('sand-progress'))customElements.define('sand-progress',SandProgress);
  if(!customElements.get('sand-mascot-progress'))customElements.define('sand-mascot-progress',SandMascotProgress);
  if(!customElements.get('sand-status'))customElements.define('sand-status',SandStatus);
  if(!customElements.get('sand-summary-card'))customElements.define('sand-summary-card',SandSummaryCard);

  function toast(options={}){
    let host=document.getElementById('sand-ui-toast-host');if(!host){host=document.createElement('div');host.id='sand-ui-toast-host';host.setAttribute('aria-live','polite');document.body.appendChild(host);}
    const tone=['success','warning','danger'].includes(options.tone)?options.tone:'info';
    const node=document.createElement('div');node.className=`sand-toast sand-toast--${tone}`;
    const mascot=options.mascot===false?'':`<img class="sand-toast__mascot" src="${options.mascot==='loading'?ASSET+'sand-mascot-loading.gif':ASSET+'sand-mascot-alert.gif'}" alt="SAND">`;
    node.innerHTML=`${mascot}<div class="sand-toast__body"><strong class="sand-toast__title"></strong><p class="sand-toast__message"></p>${options.actionText?'<button class="sand-toast__action" type="button"></button>':''}</div><button class="sand-toast__close" type="button" aria-label="ปิด">×</button>`;
    node.querySelector('.sand-toast__title').textContent=options.title||'แจ้งเตือน';node.querySelector('.sand-toast__message').textContent=options.message||'';
    const action=node.querySelector('.sand-toast__action');if(action){action.textContent=options.actionText;action.addEventListener('click',()=>{if(typeof options.onAction==='function')options.onAction();node.remove();});}
    node.querySelector('.sand-toast__close').addEventListener('click',()=>node.remove());host.appendChild(node);
    if(options.duration!==0)setTimeout(()=>node.remove(),Math.max(1500,Number(options.duration)||6500));return node;
  }
  function loading(show=true,message='กำลังโหลดข้อมูล...'){
    let el=document.querySelector('sand-loading');if(!el){el=document.createElement('sand-loading');el.innerHTML=`<div class="sand-loading-overlay" role="status" aria-live="polite"><div class="sand-loading-box"><img src="${ASSET}sand-mascot-loading.gif" alt="SAND loading"><p></p><div class="sand-progress__track"><div class="sand-progress__bar" style="width:42%;background:#7650b8"></div></div></div></div>`;document.body.appendChild(el);}
    const p=el.querySelector('p');if(p)p.textContent=message;if(show)el.setAttribute('active','');else el.removeAttribute('active');return el;
  }
  window.SANDUI=Object.freeze({toast,loading,version:'1.0.0'});
})(window,document);
