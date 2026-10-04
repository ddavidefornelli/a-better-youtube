// Dependency-free DOM/Chrome fixtures. Query counters catch accidental full-feed
// scans; real selector matching covers nested cards and unknown YouTube layouts.
export class Event {
  listeners = [];
  addListener = (fn) => { this.listeners.push(fn); };
  removeListener = (fn) => { this.listeners = this.listeners.filter((item) => item !== fn); };
  emit(...args) { return this.listeners.map((fn) => fn(...args)); }
}
class Text {
  nodeType = 3;
  constructor(text) { this.textContent = text; }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  cloneNode() { return new Text(this.textContent); }
}
function compound(element, selector) {
  if (element.nodeType !== 1) return false;
  const attributes = [...selector.matchAll(/\[([^\]=*]+)(\*=|=)?["']?([^\]"']*)["']?\]/g)];
  for (const [, name, operator, value] of attributes) {
    const actual = element.getAttribute(name);
    if (actual === null || (operator === "=" && actual !== value) || (operator === "*=" && !actual.includes(value))) return false;
  }
  const rest = selector.replace(/\[[^\]]*\]/g, "");
  const tag = rest.match(/^[\w-]+/)?.[0];
  if (tag && tag.toLowerCase() !== element.tagName.toLowerCase()) return false;
  for (const [, id] of rest.matchAll(/#([\w-]+)/g)) if (element.getAttribute("id") !== id) return false;
  for (const [, name] of rest.matchAll(/\.([\w-]+)/g)) if (!(element.getAttribute("class") || "").split(/\s+/).includes(name)) return false;
  return true;
}
export class Element {
  nodeType = 1;
  attributes = {};
  children = [];
  style = {};
  constructor(tag = "span", text = "") { this.tagName = tag.toUpperCase(); if (text) this.append(new Text(text)); }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  get isConnected() { let root = this; while (root.parentNode) root = root.parentNode; return root.nodeType === 9; }
  get textContent() { return this.children.map((child) => child.textContent).join(""); }
  set textContent(text) { for (const child of this.children) child.parentNode = null; this.children = []; if (text) this.append(new Text(text)); }
  get href() { const href = this.getAttribute("href"); return href ? new URL(href, this.doc?.url || "https://www.youtube.com/").href : ""; }
  set href(value) { this.setAttribute("href", value); }
  get title() { return this.getAttribute("title") || ""; }
  set title(value) { this.setAttribute("title", value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  matches(selector) {
    return selector.split(",").some((group) => {
      const parts = group.trim().split(/\s+/);
      if (!compound(this, parts.pop())) return false;
      let ancestor = this.parentElement;
      while (parts.length) {
        const part = parts.pop();
        while (ancestor && !compound(ancestor, part)) ancestor = ancestor.parentElement;
        if (!ancestor) return false;
        ancestor = ancestor.parentElement;
      }
      return true;
    });
  }
  closest(selector) { for (let node = this; node?.nodeType === 1; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  contains(node) { while (node) { if (node === this) return true; node = node.parentNode; } return false; }
  descendants() { return this.children.flatMap((child) => child.nodeType === 1 ? [child, ...child.descendants()] : []); }
  querySelectorAll(selector) { this.doc?.queries.push({ root: this, selector }); return this.descendants().filter((node) => node.matches(selector)); }
  querySelector(selector) { this.doc?.queries.push({ root: this, selector }); return this.descendants().find((node) => node.matches(selector)) || null; }
  attach(child) {
    child.remove?.();
    child.parentNode = this;
    const attachDoc = (node) => { node.doc = this.doc; for (const child of node.children || []) attachDoc(child); };
    attachDoc(child);
    return child;
  }
  append(...children) { this.children.push(...children.map((child) => this.attach(child))); }
  prepend(child) { this.children.unshift(this.attach(child)); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this); this.parentNode = null; }
  cloneNode(deep) {
    const copy = new Element(this.tagName);
    copy.attributes = { ...this.attributes };
    if (deep) copy.append(...this.children.map((child) => child.cloneNode(true)));
    return copy;
  }
}
let documents = 0;
export class Document extends Element {
  identity = ++documents;
  nodeType = 9;
  queries = [];
  htmlReads = 0;
  events = new Map();
  visibilityState = "visible";
  constructor(url = "https://www.youtube.com/") {
    super("document"); this.url = url; this.doc = this;
    this.documentElement = new Element("html");
    this.body = new Element("body");
    this.append(this.documentElement); this.documentElement.append(this.body);
    Object.defineProperty(this.documentElement, "outerHTML", { get: () => { this.htmlReads++; return `<html>${this.body.textContent}</html>`; } });
  }
  get isConnected() { return true; }
  matches() { return false; }
  createElement(tag) { const element = new Element(tag); element.doc = this; return element; }
  addEventListener(name, fn) { if (!this.events.has(name)) this.events.set(name, []); this.events.get(name).push(fn); }
}
export function card(title, id, duration = "12:34", layout = "classic") {
  const root = new Element(layout === "modern" ? "yt-lockup-view-model" : layout === "short" ? "ytm-shorts-lockup-view-model" : layout === "unknown" ? "new-youtube-experiment" : "ytd-video-renderer");
  if (layout === "modern") root.setAttribute("class", "yt-lockup-view-model-wiz");
  const href = layout === "short" ? `/shorts/${id}` : `/watch?v=${id}&list=ignored`;
  const thumbnail = new Element("a"); thumbnail.href = href; thumbnail.append(new Element("img"));
  const heading = new Element("h3");
  const element = new Element("a", title); element.href = href;
  if (layout === "classic") element.setAttribute("id", "video-title");
  if (layout === "modern") element.setAttribute("class", "yt-lockup-metadata-view-model-wiz__title");
  if (layout === "short") element.setAttribute("class", "shortsLockupViewModelHostMetadataTitle");
  heading.append(element);
  const overlay = new Element("ytd-thumbnail-overlay-time-status-renderer");
  const time = new Element("span", duration || ""); time.setAttribute("id", "text");
  if (layout === "modern") time.setAttribute("class", "yt-badge-shape-wiz__text");
  overlay.append(time); root.append(thumbnail, heading, overlay);
  return { root, title: element, thumbnail, time };
}

export function inDocument(doc, fn) {
  const names = ["document", "location", "__valuableBotPageReader", "__valuableBotFeedObserver", "getComputedStyle"];
  const previous = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  Object.assign(globalThis, { document: doc, location: new URL(doc.url), __valuableBotPageReader: doc.reader,
    __valuableBotFeedObserver: doc.observing, getComputedStyle: (node) => ({ position: node.style.position || "static" }) });
  try { return fn(); }
  finally { doc.reader = globalThis.__valuableBotPageReader; doc.observing = globalThis.__valuableBotFeedObserver; Object.assign(globalThis, previous); }
}
export const pause = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await pause(5); }
  throw new Error("Timed out waiting for asynchronous test work");
}
