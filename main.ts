// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// It does all ten sections of SPEC.md: the command line, the output and exit codes, safe paths, format
// detection, three-tier line matching, unified diffs, SEARCH/REPLACE blocks, V4A patches, JSON edits and
// the all-or-nothing write.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** Set at the start of run(): --strict only tries tier 0. */
let STRICT = false;
/** Successful moves, in order: [old, new]. Used only to decide R output lines. */
const MOVES: [string, string][] = [];

/* ------------------------------------------------------------------ */
/* Lines and three-tier matching (SPEC.md sections 3 and 5)           */
/* ------------------------------------------------------------------ */

interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

function trimEndWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function trimWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** First tier (0, then 1, then 2) at which `oldLines` occurs in `fileLines` at or after `from`. */
function findTier(
  fileLines: string[],
  oldLines: string[],
  from: number,
): { tier: number; positions: number[] } | null {
  const maxTier = STRICT ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const positions: number[] = [];
    for (let i = from; i + oldLines.length <= fileLines.length; i++) {
      let ok = true;
      for (let k = 0; k < oldLines.length; k++) {
        if (!lineEq(fileLines[i + k]!, oldLines[k]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of a replacement: context lines come from the file, the rest from the patch. */
interface Seg {
  text: string;
  ctx: boolean;
  oIdx: number;
  noeol: boolean;
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** Render replacement lines: context lines as the file has them, tier-2 re-indent for the rest. */
// Tier-2 re-indent (SPEC.md section 5), verified against practice: F is the
// leading whitespace of the file's first matched line (pos is where the whole
// O, context lines included, matches), P that of O's first line. A non-context
// N line that is non-empty, not all whitespace, and starts with P has P
// replaced by F; when P is empty F is prepended. Context lines always use the
// file's own matched line, never the patch's.
function renderN(n: Seg[], fileLines: string[], pos: number, tier: number, oFirst: string | null): string[] {
  const out: string[] = [];
  let f = '';
  let p = '';
  if (tier === 2 && oFirst !== null) {
    f = leadWs(fileLines[pos] ?? '');
    p = leadWs(oFirst);
  }
  for (const s of n) {
    if (s.ctx) {
      out.push(fileLines[pos + s.oIdx]!);
      continue;
    }
    if (tier === 2 && s.text !== '' && s.text.trim() !== '' && s.text.startsWith(p)) {
      out.push(f + s.text.slice(p.length));
    } else {
      out.push(s.text);
    }
  }
  return out;
}

/** A body line of a unified hunk or a V4A chunk. */
interface BodyEntry {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  noeol: boolean;
}

/** Split a hunk/chunk body into its old lines O and its replacement segments N. */
function splitBody(body: BodyEntry[]): { o: string[]; n: Seg[] } {
  const o: string[] = [];
  const n: Seg[] = [];
  for (const e of body) {
    if (e.kind === 'ctx') {
      const idx = o.length;
      o.push(e.text);
      n.push({ text: e.text, ctx: true, oIdx: idx, noeol: e.noeol });
    } else if (e.kind === 'old') {
      o.push(e.text);
    } else {
      n.push({ text: e.text, ctx: false, oIdx: -1, noeol: e.noeol });
    }
  }
  return { o, n };
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                  */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  body: BodyEntry[];
}

interface UBuild {
  diffOld: string | null | undefined;
  diffNew: string | null | undefined;
  dashOld: string | null | undefined;
  dashNew: string | null | undefined;
  hasDash: boolean;
  renOld: string | null | undefined;
  renNew: string | null | undefined;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
  headerDone: boolean;
}

function newUBuild(): UBuild {
  return {
    diffOld: undefined,
    diffNew: undefined,
    dashOld: undefined,
    dashNew: undefined,
    hasDash: false,
    renOld: undefined,
    renNew: undefined,
    create: false,
    del: false,
    hunks: [],
    headerDone: false,
  };
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Path from a `--- ` or `+++ ` header line: after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string | null {
  const s = line.slice(4).split('\t')[0]!.trim();
  if (s === '/dev/null') return null;
  return stripAB(s);
}

function unifiedEdits(lines: string[]): Edit[] {
  const sections: UBuild[] = [];
  let cur: UBuild | null = null;
  let curHunk: Hunk | null = null;

  const finishHunk = (): void => {
    if (curHunk !== null) {
      while (
        curHunk.body.length > 0 &&
        curHunk.body[curHunk.body.length - 1]!.kind === 'ctx' &&
        curHunk.body[curHunk.body.length - 1]!.text === ''
      ) {
        curHunk.body.pop();
      }
      cur!.hunks.push(curHunk);
      curHunk = null;
    }
  };

  const startSection = (b: UBuild): void => {
    finishHunk();
    cur = b;
    sections.push(b);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // A diff --git line starts a section (and ends any hunk body).
    if (line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length);
      const parts = rest.split(' ');
      if (parts.length !== 2 || !parts[0]!.startsWith('a/') || !parts[1]!.startsWith('b/')) {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      const b = newUBuild();
      b.diffOld = parts[0]!.slice(2);
      b.diffNew = parts[1]!.slice(2);
      startSection(b);
      continue;
    }
    // A --- line followed by a +++ line: part of the current header, or a new section.
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      finishHunk();
      if (cur !== null && !cur.headerDone && !cur.hasDash) {
        cur.dashOld = headerPath(line);
        cur.dashNew = headerPath(lines[i + 1]!);
        cur.hasDash = true;
        i += 1;
        continue;
      }
      const b = newUBuild();
      b.dashOld = headerPath(line);
      b.dashNew = headerPath(lines[i + 1]!);
      b.hasDash = true;
      startSection(b);
      i += 1;
      continue;
    }
    // A hunk header.
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      finishHunk();
      curHunk = { a: Number(m[1]), body: [] };
      cur.headerDone = true;
      continue;
    }
    if (curHunk !== null) {
      // Hunk body lines, or the end of the body.
      if (line === '') {
        curHunk.body.push({ kind: 'ctx', text: '', noeol: false });
      } else if (line[0] === ' ') {
        curHunk.body.push({ kind: 'ctx', text: line.slice(1), noeol: false });
      } else if (line[0] === '-') {
        curHunk.body.push({ kind: 'old', text: line.slice(1), noeol: false });
      } else if (line[0] === '+') {
        curHunk.body.push({ kind: 'new', text: line.slice(1), noeol: false });
      } else if (line[0] === '\\') {
        const last = curHunk.body[curHunk.body.length - 1];
        if (last) last.noeol = true;
      } else {
        finishHunk();
      }
      continue;
    }
    if (cur !== null && !cur.headerDone) {
      // Section header lines.
      if (line.startsWith('--- ')) {
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('rename from ')) {
        cur.renOld = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        cur.renNew = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        cur.create = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.del = true;
      }
      // index, old mode, new mode, similarity index, dissimilarity index, Index: and
      // any other line are ignored.
      continue;
    }
    // Outside a section or a body: prose and code fences are ignored.
  }
  finishHunk();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((b) => makeUnifiedEdit(b));
}

/** Apply one hunk to a file model; returns the new running offset d. */
function applyHunk(model: FileModel, hunk: Hunk, d: number, path: string): number {
  const { o, n } = splitBody(hunk.body);
  const lines = model.lines;
  if (o.length === 0) {
    const pos = Math.min(Math.max(hunk.a + d, 0), lines.length);
    const wasEnd = pos === lines.length;
    const rendered = renderN(n, lines, pos, 0, null);
    lines.splice(pos, 0, ...rendered);
    const lastN = n[n.length - 1];
    if (wasEnd && lastN) model.final = !lastN.noeol;
    return d + n.length;
  }
  const found = findTier(lines, o, 0);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let best = found.positions[0]!;
  for (const p of found.positions) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const pos = best;
  const atEnd = pos + o.length === lines.length;
  const rendered = renderN(n, lines, pos, found.tier, o[0]!);
  lines.splice(pos, o.length, ...rendered);
  if (atEnd) {
    const lastN = n[n.length - 1];
    if (lastN) model.final = !lastN.noeol;
    else if (lines.length > 0) model.final = true;
  }
  return d + (n.length - o.length);
}

function makeUnifiedEdit(b: UBuild): Edit {
  const oldP = b.dashOld !== undefined ? b.dashOld : b.renOld !== undefined ? b.renOld : b.diffOld;
  const newP = b.dashNew !== undefined ? b.dashNew : b.renNew !== undefined ? b.renNew : b.diffNew;
  const hunks = b.hunks;
  const isCreate = b.create || oldP === null;
  const isDelete = b.del || newP === null;
  return (tree) => {
    if (isCreate && newP !== null && newP !== undefined) {
      const np = newP;
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: { text: string; noeol: boolean }[] = [];
      for (const h of hunks) {
        for (const e of h.body) {
          if (e.kind === 'new') plus.push({ text: e.text, noeol: e.noeol });
        }
      }
      const text = joinFile({
        lines: plus.map((p) => p.text),
        br: '\n',
        final: plus.length > 0 ? !plus[plus.length - 1]!.noeol : false,
      });
      tree.now.set(np, text);
      return;
    }
    if (isDelete && oldP !== null && oldP !== undefined) {
      const op = oldP;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    if (oldP !== null && oldP !== undefined && newP !== null && newP !== undefined && oldP !== newP) {
      const op = oldP;
      const np = newP;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const model = splitFile(before);
      let d = 0;
      for (const h of hunks) d = applyHunk(model, h, d, op);
      tree.now.set(np, joinFile(model));
      tree.now.set(op, null);
      MOVES.push([op, np]);
      return;
    }
    if (oldP !== null && oldP !== undefined) {
      const op = oldP;
      if (!safe(op)) throw new Fail('unsafe', op);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      const model = splitFile(before);
      let d = 0;
      for (const h of hunks) d = applyHunk(model, h, d, op);
      tree.now.set(op, joinFile(model));
      return;
    }
    // Both paths /dev/null: nothing to do, but the section still counts as an edit.
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                          */
/* ------------------------------------------------------------------ */

function searchReplaceEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    // Markers belong to this block: stop at the next SEARCH line, so a block
    // missing its own markers cannot borrow a later block's (SPEC.md section 7).
    let eqIdx = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '<<<<<<< SEARCH') break;
      if (t === '=======') {
        eqIdx = j;
        break;
      }
    }
    if (eqIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let endIdx = -1;
    for (let j = eqIdx + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '<<<<<<< SEARCH') break;
      if (t === '>>>>>>> REPLACE') {
        endIdx = j;
        break;
      }
    }
    if (endIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, endIdx);
    edits.push(makeSearchReplaceEdit(path, oldLines, newLines));
    prevPath = path;
    prevEnd = endIdx;
    i = endIdx + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function makeSearchReplaceEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, joinFile({ lines: newLines, br: '\n', final: true }));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = splitFile(before);
    const found = findTier(model.lines, oldLines, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const segs: Seg[] = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1, noeol: false }));
    const rendered = renderN(segs, model.lines, pos, found.tier, oldLines[0]!);
    model.lines.splice(pos, oldLines.length, ...rendered);
    tree.now.set(path, joinFile(model));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                    */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string;
  eof: boolean;
  body: BodyEntry[];
}

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File:')) {
      const path = line.slice('*** Add File:'.length).trim();
      i++;
      const fileLines: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l) || l.trim() === '*** End Patch') break;
        if (l.startsWith('+')) {
          fileLines.push(l.slice(1));
          i++;
        } else if (l === '') {
          fileLines.push('');
          i++;
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push(makeV4aAddEdit(path, fileLines));
      continue;
    }
    if (line.startsWith('*** Delete File:')) {
      const path = line.slice('*** Delete File:'.length).trim();
      i++;
      while (i < last && blank(lines[i]!)) i++;
      edits.push(makeV4aDeleteEdit(path));
      continue;
    }
    if (line.startsWith('*** Update File:')) {
      const path = line.slice('*** Update File:'.length).trim();
      const updateLine = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to:')) {
        moveTo = lines[i]!.slice('*** Move to:'.length).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      let curChunk: VChunk | null = null;
      let firstChunk = true;
      let afterEof = false;
      const closeChunk = (strip: boolean): void => {
        if (curChunk === null) return;
        if (strip) {
          while (
            curChunk.body.length > 0 &&
            curChunk.body[curChunk.body.length - 1]!.kind === 'ctx' &&
            curChunk.body[curChunk.body.length - 1]!.text === ''
          ) {
            curChunk.body.pop();
          }
        }
        chunks.push(curChunk);
        curChunk = null;
      };
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l) || l.trim() === '*** End Patch') break;
        if (blank(l)) {
          if (curChunk !== null) {
            curChunk.body.push({ kind: 'ctx', text: '', noeol: false });
            i++;
            continue;
          }
          if (firstChunk && chunks.length === 0 && !afterEof) {
            curChunk = { anchor: '', eof: false, body: [{ kind: 'ctx', text: '', noeol: false }] };
            firstChunk = false;
            i++;
            continue;
          }
          i++;
          continue;
        }
        if (l.startsWith('@@')) {
          closeChunk(false);
          curChunk = { anchor: l.slice(2).trim(), eof: false, body: [] };
          afterEof = false;
          firstChunk = false;
          i++;
          continue;
        }
        if (l === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${i + 1}`);
          curChunk.eof = true;
          closeChunk(false);
          afterEof = true;
          i++;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (afterEof) throw new Exit2(`error: parse ${i + 1}`);
          if (curChunk === null) {
            if (!firstChunk) throw new Exit2(`error: parse ${i + 1}`);
            curChunk = { anchor: '', eof: false, body: [] };
            firstChunk = false;
          }
          const kind = l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new';
          curChunk.body.push({ kind, text: l.slice(1), noeol: false });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      closeChunk(true);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(makeV4aUpdateEdit(path, moveTo, chunks));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function makeV4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, joinFile({ lines: fileLines, br: '\n', final: true }));
  };
}

function makeV4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function makeV4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== '') {
        const anchorFound = findTier(model.lines, [ch.anchor], cursor);
        if (anchorFound === null) throw new Fail('no-match', path);
        cursor = anchorFound.positions[0]! + 1;
      }
      const { o, n } = splitBody(ch.body);
      if (o.length === 0) {
        const pos = ch.eof ? model.lines.length : cursor;
        const rendered = renderN(n, model.lines, pos, 0, null);
        model.lines.splice(pos, 0, ...rendered);
        cursor = pos + rendered.length;
        continue;
      }
      const found = findTier(model.lines, o, cursor);
      if (found === null) throw new Fail('no-match', path);
      let positions = found.positions;
      if (ch.eof) positions = positions.filter((p) => p + o.length === model.lines.length);
      if (positions.length === 0) throw new Fail('no-match', path);
      const pos = positions[0]!;
      const rendered = renderN(n, model.lines, pos, found.tier, o[0]!);
      model.lines.splice(pos, o.length, ...rendered);
      cursor = pos + rendered.length;
    }
    const text = joinFile(model);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      MOVES.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Format detection (SPEC.md section 4) and JSON edits (section 9)    */
/* ------------------------------------------------------------------ */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Running the edits (SPEC.md sections 1, 2 and 10)                   */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  STRICT = strict;
  MOVES.length = 0;
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines)
            : v4aEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: a successful move is one R line when the old path existed before the
  // patch and is gone after it, and the new path did not exist before and does after it.
  const rByNew = new Map<string, string>();
  for (const [oldP, newP] of MOVES) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rByNew.set(newP, oldP);
    }
  }
  const rOld = new Set<string>(rByNew.values());
  const rows: { key: string; text: string }[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rOld.has(p)) continue;
    if (rByNew.has(p)) {
      rows.push({ key: p, text: `R ${rByNew.get(p)!} -> ${p}` });
      continue;
    }
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.text);
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
