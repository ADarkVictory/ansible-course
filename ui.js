// DOM-free helpers for app.js, so Node can test them.

/** '#/01-foundations/02-inventories' → { module, lesson }; anything else → null. */
export function parseRoute(hash) {
  const m = /^#\/([^/]+)\/([^/]+)$/.exec(hash);
  return m && { module: m[1], lesson: m[2] };
}

/**
 * One key-bar key applied to a textarea's text and selection [start, end).
 * indent/outdent add/remove two spaces at the start of every line the selection touches; other keys replace the selection.
 * @returns { text, cursor }
 */
export function applyKey(text, start, end, key) {
  if (key === 'indent' || key === 'outdent') {
    const from = text.lastIndexOf('\n', start - 1) + 1;
    const lines = text.slice(from, end).split('\n').length;
    const rest = text.slice(from).split('\n');
    let cursor = end, lineStart = from;
    for (let i = 0; i < lines; i++) {
      const line = rest[i];
      if (key === 'indent') { rest[i] = `  ${line}`; cursor += 2; }
      else {
        const cut = /^ {0,2}/.exec(line)[0].length;
        rest[i] = line.slice(cut);
        cursor -= i < lines - 1 ? cut : Math.min(cut, end - lineStart);
      }
      lineStart += line.length + 1;
    }
    return { text: text.slice(0, from) + rest.join('\n'), cursor };
  }
  const [insert, back] = key === '{{ }}' ? ['{{  }}', 3] : [key, 0];
  return { text: text.slice(0, start) + insert + text.slice(end), cursor: start + insert.length - back };
}

const KEY = 'ansible-course-progress';

/** The saved progress object; {} when storage is missing, throws (blocked, private mode) or holds junk. */
export function loadProgress(storage) {
  try {
    const v = JSON.parse(storage.getItem(KEY));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Saves progress; does nothing when storage is missing or throws (blocked, full). */
export function saveProgress(storage, data) {
  try { storage.setItem(KEY, JSON.stringify(data)); } catch { /* the site works without saved progress */ }
}

/** A banner line as ansible-core's Display.banner prints it: text, a space, then a run of `*` to the end of the line. */
export const isBanner = (line) => /\S \*+$/.test(line);
