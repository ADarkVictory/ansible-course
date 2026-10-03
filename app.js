// The site: hash router, lesson rendering, exercises and progress. The only file that touches the DOM.
// Learner and engine text only ever reaches the page as text (textContent / text nodes); innerHTML is used only for
// our own Markdown (lessons, and exercise task/question/option/why text from the .ex.yaml files).
import * as yaml from './vendor/js-yaml.mjs';
import { marked } from './vendor/marked.esm.js';
import { checkWrite, checkCommand, checkChoice } from './checker.js';
import { parseRoute, applyKey, loadProgress, saveProgress, isBanner } from './ui.js';

const $ = (id) => document.getElementById(id);
const storage = (() => { try { return window.localStorage; } catch { return undefined; } })();
const progress = loadProgress(storage);
progress.ex ??= {};      // { [exercise id]: { done?, solutionShown?, code? } }
progress.lessons ??= {}; // { '<module-dir>/<lesson-file>': true } once every exercise in it is done
const save = () => saveProgress(storage, progress);
const KEYS = [['indent', '⇥', 'Indent'], ['outdent', '⇤', 'Outdent'], ['-', '-', 'Insert -'], [':', ':', 'Insert :'],
  ['"', '"', 'Insert "'], ['{{ }}', '{{ }}', 'Insert {{ }}']];
let course, registry, keywords, lessons, seq = 0;

// h('p', { className: 'x', 'aria-label': 'y' }, ...children): DOM properties where they exist, attributes otherwise;
// string children become text nodes, never HTML.
function h(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) k in e && !k.includes('-') ? (e[k] = v) : e.setAttribute(k, v);
  e.append(...children.filter((c) => c != null && c !== false));
  return e;
}
const markdown = (text, inline) => {
  const e = h(inline ? 'span' : 'div', { className: inline ? '' : 'prose' });
  e.innerHTML = inline ? marked.parseInline(String(text ?? '')) : marked.parse(String(text ?? ''));
  return e;
};

async function get(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.text();
}

function failed(message) {
  return h('div', { className: 'notice' }, h('p', {}, message), h('p', {}, h('a', { href: `#/${lessons?.[0]?.key ?? ''}` }, 'Go to the first lesson')));
}

async function boot() {
  try {
    [course, registry, keywords] = await Promise.all(['course.yaml', 'modules.yaml', 'keywords.yaml'].map(async (p) => yaml.load(await get(p))));
  } catch (e) {
    $('lesson').replaceChildren(h('p', { className: 'notice' }, `The course could not load (${e.message}). Check your connection and reload.`));
    return;
  }
  lessons = course.modules.flatMap((m) => m.lessons.map((l) => ({ ...l, key: `${m.dir}/${l.file}` })));
  const dialog = $('syllabus');
  $('menu').onclick = () => dialog.showModal();
  $('close').onclick = () => dialog.close();
  // The drawer fills the dialog, so a click on the dialog itself is a click on the backdrop.
  dialog.onclick = (e) => { if (e.target === dialog || e.target.closest('a')) dialog.close(); };
  addEventListener('hashchange', () => show(true));
  show(false);
}

async function show(navigated) {
  const token = ++seq;
  const route = parseRoute(location.hash);
  if (!route) history.replaceState(null, '', `#/${lessons[0].key}`);
  const i = route ? lessons.findIndex((l) => l.key === `${route.module}/${route.lesson}`) : 0;
  const article = $('lesson');
  if (i < 0) {
    article.replaceChildren(failed('There is no lesson at this address.'));
    $('pager').replaceChildren();
    renderToc();
    return;
  }
  const lesson = lessons[i];
  let text, exercises;
  try {
    [text, exercises] = await Promise.all([get(`lessons/${lesson.key}.md`), get(`lessons/${lesson.key}.ex.yaml`).then((t) => yaml.load(t) ?? [])]);
    // A command exercise's `output_golden: <stem>` is the real Ansible output it shows on success.
    await Promise.all(exercises.filter((e) => e.output_golden).map(async (e) => { e.output = await get(`tests/golden/${e.output_golden}.txt`); }));
  } catch (e) {
    if (token === seq) article.replaceChildren(failed(`This lesson could not load (${e.message}).`));
    return;
  }
  if (token !== seq) return; // the learner has already moved on

  document.title = `${lesson.title} · Ansible course`;
  article.innerHTML = marked.parse(text);
  const byId = new Map(exercises.map((e) => [e.id, e]));
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_COMMENT);
  const markers = [];
  while (walker.nextNode()) markers.push(walker.currentNode);
  for (const c of markers) {
    const id = /^\s*exercise:\s*(\S+?)\s*$/.exec(c.data)?.[1];
    if (!id) continue;
    const ex = byId.get(id);
    c.replaceWith(ex ? exercise(ex, () => lessonProgress(i, exercises)) : h('p', { className: 'notice' }, `Missing exercise: ${id}`));
  }
  addTryIt(article);
  lessonProgress(i, exercises);
  renderPager(i);
  if (navigated) {
    scrollTo(0, 0);
    $('main').focus({ preventScroll: true });
  }
}

function lessonProgress(i, exercises) {
  const done = exercises.filter((e) => progress.ex[e.id]?.done).length;
  if (exercises.length && done === exercises.length && !progress.lessons[lessons[i].key]) {
    progress.lessons[lessons[i].key] = true;
    save();
  }
  $('top-title').textContent = lessons[i].title;
  $('top-progress').textContent = `Lesson ${i + 1} of ${lessons.length}${exercises.length ? ` · ${done}/${exercises.length} exercises done` : ''}`;
  renderToc(lessons[i].key);
}

function renderToc(current) {
  $('toc').replaceChildren(...course.modules.map((m, n) => h('section', {},
    h('h3', {}, h('span', { className: 'num' }, `Module ${n + 1}`), m.title),
    h('ol', {}, ...m.lessons.map((l) => {
      const key = `${m.dir}/${l.file}`;
      const done = progress.lessons[key];
      const a = h('a', { href: `#/${key}`, className: done ? 'done' : '' },
        h('span', { className: 'tick', 'aria-hidden': 'true' }), l.title, done && h('span', { className: 'sr' }, ' (done)'));
      if (key === current) a.setAttribute('aria-current', 'page');
      return h('li', {}, a);
    })))));
}

function renderPager(i) {
  const link = (j, label, cls) => lessons[j] && h('a', { href: `#/${lessons[j].key}`, className: cls }, h('small', {}, label), lessons[j].title);
  $('pager').replaceChildren(...[link(i - 1, '← Previous', 'prev'), link(i + 1, 'Next →', 'next')].filter(Boolean));
}

function exercise(ex, onDone) {
  const rec = () => (progress.ex[ex.id] ??= {});
  const kind = { write: 'Write', command: 'Command', choice: 'Question' }[ex.type] ?? ex.type;
  const box = h('section', { className: `ex ${progress.ex[ex.id]?.done ? 'done' : ''}`, 'aria-label': `${kind} exercise` },
    h('header', { className: 'ex-head' }, h('span', { className: 'kind' }, kind), h('span', { className: 'badge' }, 'Done')));
  const markDone = () => {
    if (rec().done) return;
    rec().done = true;
    box.classList.add('done');
    save();
    onDone();
  };
  (ex.type === 'choice' ? choice : attempt)(ex, box, markDone, rec);
  return box;
}

function choice(ex, box, markDone) {
  box.append(markdown(ex.question));
  if (ex.code) box.append(h('pre', {}, h('code', { textContent: ex.code })));
  box.append(h('div', { className: 'options' }, ...ex.options.map((o, i) => {
    const why = h('p', { className: 'why', 'aria-live': 'polite' });
    const btn = h('button', { type: 'button', className: 'option' }, markdown(o.text, true));
    btn.onclick = () => {
      const r = checkChoice(ex, i);
      btn.classList.add(r.ok ? 'right' : 'wrong');
      why.replaceChildren(h('strong', {}, r.ok ? 'Correct. ' : 'Not quite. '), markdown(o.why, true));
      if (r.ok) markDone();
    };
    return h('div', { className: 'opt' }, btn, why);
  })));
}

// write and command exercises: an editor, Run, the terminal pane, the hint, and Show solution after three failures.
function attempt(ex, box, markDone, rec) {
  box.append(markdown(ex.task));
  if (ex.inventory) box.append(h('p', { className: 'label' }, 'Inventory'), h('pre', { className: 'inv' }, h('code', { textContent: ini(ex.inventory) })));
  const result = h('div', { className: 'result', 'aria-live': 'polite' });
  const help = h('div', { className: 'help' });
  let fails = 0, field;

  const report = (r, again) => {
    result.replaceChildren(...[
      h('p', { className: `verdict ${r.ok ? 'ok' : 'bad'}` }, r.ok ? (again ? '✓ Second run' : '✓ Correct') : '✗ Not yet'),
      !r.ok && r.hint && h('p', { className: 'hint' }, h('strong', {}, 'Hint: '), r.hint),
      r.output && terminal(r.output),
      r.ok && ex.type === 'write' && h('div', { className: 'again' },
        h('button', { type: 'button', className: 'secondary', onclick: () => report(checkWrite(ex, field.value, registry, keywords, { second: true }), true) }, 'Run again'),
        h('span', { className: 'muted' }, 'See what a second run changes.')),
    ].filter(Boolean));
    if (r.ok) markDone();
    else if (++fails >= 3 && !help.hasChildNodes()) {
      help.append(h('button', { type: 'button', className: 'secondary', onclick: () => {
        rec().solutionShown = true;
        save();
        const label = h('p', { className: 'label', tabIndex: -1 }, 'Solution');
        help.replaceChildren(label, h('pre', {}, h('code', { textContent: ex.solution })));
        label.focus();
      } }, 'Show solution'));
    }
    result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  const saved = progress.ex[ex.id]?.code;
  // Attributes, not properties: autocorrect's property is a boolean in some browsers, so 'off' would turn it on.
  const plain = (e) => { for (const k of ['autocapitalize', 'autocomplete', 'autocorrect']) e.setAttribute(k, 'off'); e.setAttribute('spellcheck', 'false'); return e; };
  if (ex.type === 'write') {
    field = plain(h('textarea', { value: saved ?? ex.starter ?? '', wrap: 'off', 'aria-label': 'Playbook editor' }));
    const gutter = h('pre', { className: 'gutter', 'aria-hidden': 'true' });
    // The textarea never scrolls vertically: it is as tall as its lines, so the gutter's numbers stay level with them.
    const fit = () => {
      const lines = field.value.split('\n').length;
      gutter.textContent = Array.from({ length: lines }, (_, n) => n + 1).join('\n');
      field.style.height = `calc(${lines} * var(--lh) + 2 * var(--pad) + ${field.offsetHeight - field.clientHeight}px)`;
    };
    field.addEventListener('input', () => { fit(); rec().code = field.value; save(); });
    requestAnimationFrame(fit);
    const keys = KEYS.map(([key, label, name]) => h('button', {
      type: 'button', className: key.endsWith('dent') ? 'key glyph' : 'key', 'aria-label': name,
      onmousedown: (e) => e.preventDefault(), // keep the textarea focused, so the on-screen keyboard stays up
      onclick: () => {
        const r = applyKey(field.value, field.selectionStart, field.selectionEnd, key);
        field.value = r.text;
        field.focus();
        field.setSelectionRange(r.cursor, r.cursor);
        field.dispatchEvent(new Event('input'));
      },
    }, label));
    const run = h('button', { type: 'button', className: 'run', onclick: () => {
      if (document.activeElement === field) field.blur(); // close the on-screen keyboard so the output is visible
      report(checkWrite(ex, field.value, registry, keywords));
    } }, 'Run');
    box.append(h('div', { className: 'editor' }, gutter, field), h('div', { className: 'bar' }, h('div', { className: 'keys' }, ...keys), run));
  } else {
    field = plain(h('input', { type: 'text', value: saved ?? '', enterKeyHint: 'go', 'aria-label': 'Command' }));
    field.addEventListener('input', () => { rec().code = field.value; save(); });
    box.append(h('form', { className: 'cmd', onsubmit: (e) => {
      e.preventDefault();
      field.blur();
      report(checkCommand(ex, field.value, registry));
    } }, h('span', { className: 'prompt', 'aria-hidden': 'true' }, '$'), field, h('button', { className: 'run' }, 'Run')));
  }
  box.append(result, help);
}

// The terminal pane wraps long lines as a narrow terminal does, except banners (PLAY [...] ****): Ansible pads those to at least
// 80 columns, so their surplus stars are clipped at the edge instead of wrapping. The text stays byte-exact, so copying it is unchanged.
const terminal = (text) => h('pre', { className: 'term' },
  ...text.split('\n').flatMap((line, i) => [i ? '\n' : null, isBanner(line) ? h('span', { className: 'banner' }, line) : line]));

// The engine's inventories are { group: [hosts] }; shown as the INI file the lessons teach.
const ini = (inv) => Object.entries(inv).map(([g, hosts]) =>
  Array.isArray(hosts) ? `[${g}]\n${hosts.join('\n')}` : yaml.dump({ [g]: hosts }).trimEnd()).join('\n\n');

// Each lesson code block followed by an exercise gets a Try it button that copies it into the next editor below.
function addTryIt(article) {
  const editors = [...article.querySelectorAll('.ex textarea, .ex input')];
  for (const pre of article.querySelectorAll('pre')) {
    if (pre.closest('.ex')) continue;
    const target = editors.find((ed) => pre.compareDocumentPosition(ed) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (!target) continue;
    const lang = /language-(\S+)/.exec(pre.querySelector('code')?.className ?? '')?.[1] ?? '';
    pre.before(h('div', { className: 'code-head' }, h('span', {}, lang), h('button', {
      type: 'button', className: 'try', 'aria-label': 'Try it in the exercise below',
      onclick: () => {
        const code = pre.textContent.trim();
        target.value = target.tagName === 'INPUT' ? code.split('\n')[0].replace(/^\$\s*/, '') : code;
        target.dispatchEvent(new Event('input'));
        target.closest('.ex').scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
    }, 'Try it ↓')));
    pre.classList.add('headed');
  }
}

// iOS Safari does not shrink the layout viewport for the on-screen keyboard (interactive-widget is Android-only), so a sticky
// bottom bar would sit behind the keyboard. --kb is the height of whatever covers the bottom of the layout viewport; the bar sits on top of it.
const vv = window.visualViewport;
if (vv) {
  const kb = () => document.documentElement.style.setProperty('--kb', `${Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop))}px`);
  vv.addEventListener('resize', kb);
  vv.addEventListener('scroll', kb);
}

boot();
