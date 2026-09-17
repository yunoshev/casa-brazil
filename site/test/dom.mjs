// Minimal DOM for the product's forms, events and viewport observer. No network
// or browser runtime. Tests exercise the shipped scripts through public hooks.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

class Element {
  constructor(tag = 'div', attrs = {}) {
    this.tagName = tag.toUpperCase(); this.attrs = attrs; this.children = [];
    this.listeners = {}; this.value = ''; this.checked = false; this.disabled = false;
    this.hidden = 'hidden' in attrs; this.isConnected = true; this._html = ''; this._text = '';
    this.classList = {
      add: (...names) => { const all = new Set((this.attrs.class || '').split(/\s+/).filter(Boolean)); names.forEach(x => all.add(x)); this.attrs.class = [...all].join(' '); },
      remove: (...names) => { const gone = new Set(names); this.attrs.class = (this.attrs.class || '').split(/\s+/).filter(x => x && !gone.has(x)).join(' '); },
      contains: name => (this.attrs.class || '').split(/\s+/).includes(name),
    };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  hasAttribute(k) { return k in this.attrs; }
  appendChild(el) { this.children.push(el); el.parent = this; return el; }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  removeEventListener(name, fn) { this.listeners[name] = (this.listeners[name] || []).filter(listener => listener !== fn); }
  async click() {
    if (this.disabled) return;
    this.clicked = true;
    let prevented = false;
    await this.emit('click', { preventDefault() { prevented = true; } });
    // Only the native button/form default action needed by the CTA tests.
    if (!prevented && this.tagName === 'BUTTON' && this.getAttribute('type') === 'submit') {
      let root = this;
      while (root.parent) root = root.parent;
      const form = this.hasAttribute('form')
        ? root.querySelectorAll('form').find(el => el.getAttribute('id') === this.getAttribute('form'))
        : this.closest('form');
      if (form) await form.emit('submit', { submitter: this });
    }
  }
  async emit(name, extra = {}) { for (const fn of this.listeners[name] || []) await fn({ preventDefault() {}, target: this, ...extra }); }
  checkValidity() { return true; } // explicit product validators are still tested
  focus() { this.focused = true; }
  scrollIntoView() { this.scrolled = true; }
  matches(selector) {
    if (selector.startsWith('.')) return (this.attrs.class || '').split(/\s+/).includes(selector.slice(1));
    if (selector.startsWith('[')) return this.hasAttribute(selector.slice(1, -1));
    return this.tagName.toLowerCase() === selector;
  }
  closest(selectors) {
    for (let el = this; el; el = el.parent) if (selectors.split(',').some(s => el.matches(s.trim()))) return el;
    return null;
  }
  querySelectorAll(selectors) {
    const out = [];
    const match = (el, sel) => {
      const parts = sel.trim().split(/\s+/), last = parts.pop();
      if (!el.matches(last)) return false;
      return !parts.length || !!el.parent?.closest(parts.join(' '));
    };
    const walk = el => { for (const child of el.children) { if (selectors.split(',').some(s => match(child, s))) out.push(child); walk(child); } };
    walk(this); return out;
  }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  get textContent() { return this._text + this.children.map(x => x.textContent).join(''); }
  set textContent(value) { this._text = String(value); this._html = ''; this.children = []; }
  get innerHTML() { return this._html; }
  set innerHTML(html) {
    this._html = html; this._text = ''; this.children = [];
    const stack = [this];
    for (const token of html.match(/<[^>]+>|[^<]+/g) || []) {
      if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
      if (!token.startsWith('<')) { stack.at(-1)._text += token; continue; }
      const tag = token.match(/^<([\w-]+)/)?.[1]; if (!tag) continue;
      const attrs = {};
      for (const m of token.slice(tag.length + 1, -1).matchAll(/([\w-]+)(?:="([^"]*)"|'([^']*)')?/g)) attrs[m[1]] = m[2] ?? m[3] ?? '';
      const el = stack.at(-1).appendChild(new Element(tag, attrs));
      if (!['input', 'br', 'img', 'meta', 'link', 'hr'].includes(tag)) stack.push(el);
    }
  }
}

export function response(status, body, headers = {}) {
  return { status, ok: status >= 200 && status < 300, headers: { get: k => headers[k] ?? null }, json: async () => body };
}
export function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
export async function until(fn) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 1)); }
  throw new Error('condition not reached');
}
export function setup(options = {}) {
  const document = new Element('document');
  document.readyState = options.loading ? 'loading' : 'complete';
  document.head = document.appendChild(new Element('head'));
  document.body = document.appendChild(new Element('body'));
  document.createElement = tag => new Element(tag);
  document.getElementById = id => document.querySelectorAll('[id]').find(el => el.getAttribute('id') === id) || null;
  document.referrer = options.referrer || '';
  const box = document.body.appendChild(new Element('section', {
    'data-az': '034aa2e652ab4905',
    'data-az-source': 'https://venda-imoveis.caixa.gov.br/sistema/detalhe-imovel.asp?hdnimovel=8444412843294',
  }));
  if (options.prefill) box.setAttribute('data-az-pdf', options.prefill);
  if (options.lotId) box.setAttribute('data-az', options.lotId);
  if (options.source) box.setAttribute('data-az-source', options.source);
  const data = options.storage || new Map(), requests = [], events = [], timers = new Map(), observers = [];
  let timerID = 0;
  const lang = options.lang || 'pt';
  const catalogue = JSON.parse(readFileSync(new URL('../i18n/' + lang + '.json', import.meta.url)));
  const translate = (key, p) => (catalogue[key] || '[' + key + ']').replace(/\{(\w+)\}/g, (m, k) => p?.[k] ?? m);
  class TestFormData {
    constructor() { this.entries = []; }
    append(...args) { this.entries.push(args); }
  }
  const sandbox = {
    URL, Date, Promise, Uint8Array, TextEncoder, AbortController, crypto: webcrypto,
    FormData: options.FormData || TestFormData,
    document, navigator: { webdriver: false },
    location: new URL(options.url || 'https://precodemartelo.com/casa-brazil/leilao-de-imoveis/rj/rio-de-janeiro/lote/apartment-123/'),
    LANG: options.noLang ? undefined : { code: lang, t: translate },
    __ANALYSIS__: Object.hasOwn(options, 'analysisConfig') ? options.analysisConfig : { enabled: true },
    __ANALYTICS__: options.analyticsConfig ?? { ga4: 'G-TEST123', enhancedMeasurementDisabled: true },
    localStorage: { getItem(k) { if (options.storageBlocked) throw Error('blocked'); return data.get(k) ?? null; }, setItem(k, v) { if (options.storageBlocked) throw Error('blocked'); data.set(k, v); } },
    setTimeout(fn, ms) { const id = ++timerID; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (url, init) => { requests.push({ url, ...init, json: typeof init.body === 'string' ? JSON.parse(init.body) : null }); return options.fetch ? options.fetch(requests.at(-1), requests.length) : response(503, { error: 'analysis_unavailable' }); },
    track(name, params) { if (options.trackThrows) throw Error('blocked'); events.push({ name, params }); },
    MutationObserver: class {
      constructor(fn) { sandbox.notifyMutation = fn; }
      observe() {}
    },
    IntersectionObserver: class {
      constructor(fn) { this.fn = fn; this.nodes = []; observers.push(this); }
      observe(n) { this.nodes.push(n); } disconnect() { this.nodes = []; }
      show(isIntersecting = true) { this.fn(this.nodes.map(target => ({ target, isIntersecting, intersectionRatio: isIntersecting ? 1 : 0 }))); }
    },
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  return {
    window: sandbox, document, box, data, events, requests, timers, observers, translate,
    load(name) { vm.runInContext(readFileSync(new URL('../parts/' + name + '.js', import.meta.url), 'utf8'), ctx, { filename: name + '.js' }); },
    runTimers(max = Infinity) { for (const [id, timer] of [...timers]) if (timer.ms <= max) { timers.delete(id); timer.fn(); } },
    form() { return box.querySelector('.azform'); }, input() { return box.querySelector('.azform')?.querySelector('input') || null; },
    async analyze() { await this.form().emit('submit'); },
  };
}
