#!/usr/bin/env node
'use strict';
/*
 * strip-elf-debug.js — produce a smaller ELF that is still usable with GDB,
 * with a tunable amount of debug info. Pure Node (no toolchain, no deps).
 *
 * It always keeps the section header table (with original addresses) and the
 * symbol tables (.symtab / .strtab). The contents of every loadable
 * (SHF_ALLOC) section — .text, .rodata, .data, etc. — are always dropped,
 * because that code/data already lives on the device you are debugging (their
 * headers are retyped to NOBITS so addresses still resolve). Program headers
 * are dropped (GDB uses sections for symbolic debugging).
 *
 * How much DWARF to keep is controlled by --level (and fine-tuned by
 * --keep/--drop). More DWARF = larger file = more debugging power:
 *
 *   --level symbols   No DWARF. Just the symbol tables.
 *                     -> function-name breakpoints, named backtraces, disasm.
 *                        NO source lines, NO variable inspection. Tiny.
 *
 *   --level globals   Type/variable info only — no line tables, no location
 *                     lists, no CFI.
 *                     -> inspect GLOBAL/static variables by name and type
 *                        (`print my_global`). NO source-line stepping.
 *
 *   --level lite      DWARF minus the big optional sections (location lists,
 *                     call-frame info, macros).
 *                     -> source-line stepping and most variable inspection.
 *
 *   --level full      All DWARF (default).
 *                     -> everything: precise locals, CFI unwinding, macros.
 *
 * Narrow debug info to specific source files (DWARF compilation units). This
 * keeps only the matching CUs inside .debug_info and trims .debug_abbrev /
 * .debug_str to just what they reference — by far the biggest size win when
 * you only care about one file's globals:
 *
 *   --only-cu <substr>[,<substr>...]   keep only CUs whose source path
 *                                      contains any given substring.
 *                                      Implies --level globals (drops line/loc/
 *                                      frame/ranges/aranges too).
 *   --list-cu                          list every CU (source file) and its
 *                                      size in .debug_info, then exit.
 *
 * Fine-grained section overrides (comma-separated name prefixes; --drop wins):
 *   --keep .debug_frame,.debug_loc     force-keep matching sections
 *   --drop .debug_str                  force-drop matching sections
 *
 * Preview without writing:
 *   --list            print every section, its size, and keep/drop decision.
 *
 * Usage:
 *   node strip-elf-debug.js [options] <input.elf> [output.elf]
 *   node strip-elf-debug.js --level lite build/zephyr/zephyr.elf
 *   node strip-elf-debug.js --only-cu main.cpp build/zephyr/zephyr.elf
 *   node strip-elf-debug.js --list-cu build/zephyr/zephyr.elf
 *
 * Debug in GDB:
 *   arm-none-eabi-gdb build/zephyr/zephyr.debug.elf
 */

const fs = require('fs');
const path = require('path');

const SHF_ALLOC = 0x2;
const SHT_NULL = 0;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_NOBITS = 8;

// DWARF sections dropped at each level (prefix match). Higher levels drop less.
const DROP_SYMBOLS = ['.debug', '.zdebug'];
const DROP_LITE = [
  '.debug_loc', '.debug_loclists',
  '.debug_frame',
  '.debug_macro', '.debug_macinfo',
  '.debug_pubnames', '.debug_pubtypes',
  '.debug_gnu_pubnames', '.debug_gnu_pubtypes',
];
const DROP_GLOBALS = [...DROP_LITE, '.debug_line', '.debug_ranges', '.debug_rnglists'];
const LEVELS = {
  symbols: DROP_SYMBOLS,
  globals: DROP_GLOBALS,
  lite: DROP_LITE,
  full: [],
};

function fail(msg) {
  console.error('error: ' + msg);
  process.exit(1);
}

// --- argument parsing -------------------------------------------------------
const splitList = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);
const matchesAny = (name, prefixes) => prefixes.some((p) => name === p || name.startsWith(p));

function parseArgs(args) {
  const o = { level: null, keep: [], drop: [], onlyCu: [], list: false, listCu: false, positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--list') o.list = true;
    else if (a === '--list-cu') o.listCu = true;
    else if (a === '--level') o.level = args[++i];
    else if (a.startsWith('--level=')) o.level = a.slice(8);
    else if (a === '--keep') o.keep.push(...splitList(args[++i]));
    else if (a.startsWith('--keep=')) o.keep.push(...splitList(a.slice(7)));
    else if (a === '--drop') o.drop.push(...splitList(args[++i]));
    else if (a.startsWith('--drop=')) o.drop.push(...splitList(a.slice(7)));
    else if (a === '--only-cu') o.onlyCu.push(...splitList(args[++i]));
    else if (a.startsWith('--only-cu=')) o.onlyCu.push(...splitList(a.slice(10)));
    else if (a === '--symbols-only') o.level = 'symbols'; // back-compat
    else if (a.startsWith('--')) fail('unknown option: ' + a);
    else o.positional.push(a);
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));
// --only-cu implies lite-level detail (keeps source-line tables so breakpoints
// like `break main.cpp:1390` work) plus CU narrowing. Pass --level globals
// explicitly alongside --only-cu for an even smaller file without line info.
if (opts.onlyCu.length && !opts.level) opts.level = 'lite';
if (!opts.level) opts.level = 'full';
if (!LEVELS[opts.level]) {
  fail(`unknown --level "${opts.level}" (choose: ${Object.keys(LEVELS).join(', ')})`);
}
const inPath = opts.positional[0];
if (!inPath) {
  fail('usage: node strip-elf-debug.js [--level ...] [--only-cu <substr>] [--list|--list-cu] <input.elf> [output.elf]');
}
const outPath =
  opts.positional[1] ||
  path.join(
    path.dirname(inPath),
    path.basename(inPath, path.extname(inPath)) + '.debug' + (path.extname(inPath) || '.elf')
  );

const buf = fs.readFileSync(inPath);
if (buf.length < 20 || buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) {
  fail('not an ELF file');
}

const is64 = buf[4] === 2; // EI_CLASS: 1 = 32-bit, 2 = 64-bit
const isLE = buf[5] === 1; // EI_DATA:  1 = little-endian, 2 = big-endian

// --- endian-aware readers/writers ------------------------------------------
const rd16 = (o) => (isLE ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
const rd32 = (o) => (isLE ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
const rd64 = (o) => Number(isLE ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o));
const rdN = is64 ? rd64 : rd32;

function wr16(b, o, v) { isLE ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o); }
function wr32(b, o, v) { isLE ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o); }
function wr64(b, o, v) { isLE ? b.writeBigUInt64LE(BigInt(v), o) : b.writeBigUInt64BE(BigInt(v), o); }
const wrN = is64 ? wr64 : wr32;

// --- ELF header field offsets ----------------------------------------------
const EH = is64
  ? { phoff: 32, shoff: 40, phentsize: 54, phnum: 56, shentsize: 58, shnum: 60, shstrndx: 62, size: 64 }
  : { phoff: 28, shoff: 32, phentsize: 42, phnum: 44, shentsize: 46, shnum: 48, shstrndx: 50, size: 52 };

const shoff = rdN(EH.shoff);
const shentsize = rd16(EH.shentsize);
const shnum = rd16(EH.shnum);
const shstrndx = rd16(EH.shstrndx);
if (!shoff || !shnum) fail('ELF has no section headers — nothing to strip for GDB');

const SH = is64
  ? { name: 0, type: 4, flags: 8, addr: 16, offset: 24, size: 32, addralign: 48 }
  : { name: 0, type: 4, flags: 8, addr: 12, offset: 16, size: 20, addralign: 28 };
const rdFlags = is64 ? rd64 : rd32;

const shstrOff = rdN(shoff + shstrndx * shentsize + SH.offset);
function secName(nameOff) {
  let e = shstrOff + nameOff;
  while (e < buf.length && buf[e] !== 0) e++;
  return buf.toString('ascii', shstrOff + nameOff, e);
}

// --- parse all section headers ---------------------------------------------
const secs = [];
const byName = {};
for (let i = 0; i < shnum; i++) {
  const base = shoff + i * shentsize;
  const s = {
    idx: i,
    raw: buf.subarray(base, base + shentsize),
    name: secName(rd32(base + SH.name)),
    type: rd32(base + SH.type),
    flags: Number(rdFlags(base + SH.flags)),
    offset: rdN(base + SH.offset),
    size: rdN(base + SH.size),
    align: Number(rdN(base + SH.addralign)),
  };
  secs.push(s);
  if (s.name) byName[s.name] = s;
}

// ===========================================================================
//  DWARF compilation-unit surgery (for --only-cu / --list-cu)
// ===========================================================================
const d16 = (p) => (isLE ? buf.readUInt16LE(p) : buf.readUInt16BE(p));
const d32 = (p) => (isLE ? buf.readUInt32LE(p) : buf.readUInt32BE(p));
function uleb(p) { let r = 0, s = 0, x; do { x = buf[p++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80); return [r, p]; }
function sleb(p) { let r = 0, s = 0, x; do { x = buf[p++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80); if (s < 32 && (x & 0x40)) r |= -1 << s; return [r, p]; }

// Advance past one attribute value. Returns {next, form, valPos} where `form`
// is the effective form (resolving DW_FORM_indirect) and valPos is where the
// value bytes begin. addr = address size, os = DWARF offset size (4 here).
function advanceForm(f, p, addr, os) {
  if (f === 0x16) { let ff; [ff, p] = uleb(p); return advanceForm(ff, p, addr, os); } // indirect
  const valPos = p;
  switch (f) {
    case 0x01: p += addr; break;                      // addr
    case 0x21: break;                                 // implicit_const (no bytes)
    case 0x0b: case 0x0c: case 0x11: p += 1; break;   // data1 / flag / ref1
    case 0x05: case 0x12: p += 2; break;              // data2 / ref2
    case 0x06: case 0x13: case 0x17: p += 4; break;   // data4 / ref4 / sec_offset
    case 0x0e: case 0x1f: p += os; break;             // strp / line_strp
    case 0x10: p += os; break;                        // ref_addr
    case 0x07: case 0x14: p += 8; break;              // data8 / ref8
    case 0x0d: [, p] = sleb(p); break;                // sdata
    case 0x0f: case 0x15: case 0x1a: case 0x1b: [, p] = uleb(p); break; // udata/ref_udata/strx/addrx
    case 0x08: while (buf[p]) p++; p++; break;         // string
    case 0x18: { let n; [n, p] = uleb(p); p += n; break; } // exprloc
    case 0x09: { let n; [n, p] = uleb(p); p += n; break; } // block
    case 0x0a: p += 1 + buf[p]; break;                // block1
    case 0x19: break;                                 // flag_present
    case 0x25: p += 1; break; case 0x26: p += 2; break; // strx1/strx2
    case 0x27: p += 3; break; case 0x28: p += 4; break; // strx3/strx4
    case 0x29: p += 1; break; case 0x2a: p += 2; break; // addrx1/addrx2
    case 0x2b: p += 3; break; case 0x2c: p += 4; break; // addrx3/addrx4
    case 0x1e: p += 16; break;                        // data16
    default: throw new Error('unhandled DWARF form 0x' + f.toString(16));
  }
  return { next: p, form: f, valPos };
}

// Parse the abbrev table at absolute offset `abs`; returns {map, endAbs}.
function parseAbbrevTable(abs) {
  const map = {}; let p = abs;
  for (;;) {
    let code; [code, p] = uleb(p);
    if (code === 0) break;
    let tag; [tag, p] = uleb(p);
    p++; // has-children byte
    const attrs = [];
    for (;;) {
      let at, form; [at, p] = uleb(p); [form, p] = uleb(p);
      if (form === 0x21) [, p] = sleb(p); // implicit_const value
      if (at === 0 && form === 0) break;
      attrs.push([at, form]);
    }
    map[code] = attrs;
  }
  return { map, endAbs: p };
}

function readStr(sec, off) { let e = sec.offset + off; while (buf[e]) e++; return buf.toString('utf8', sec.offset + off, e); }

// Walk .debug_info and return one record per CU.
function parseCUs() {
  const di = byName['.debug_info'], da = byName['.debug_abbrev'], dstr = byName['.debug_str'];
  if (!di || !da) fail('this ELF has no .debug_info/.debug_abbrev — cannot narrow by CU');
  const abbrevCache = {};
  const getAbbrev = (off) => (abbrevCache[off] ||= parseAbbrevTable(da.offset + off));
  const cus = [];
  let p = di.offset; const end = di.offset + di.size;
  while (p < end) {
    const cs = p;
    const len = d32(p);
    if (len === 0xffffffff) fail('64-bit DWARF is not supported by this tool');
    const next = p + 4 + len;
    const ver = d16(p + 4);
    let abbrevOff, addrSize, q;
    if (ver >= 5) { addrSize = buf[p + 7]; abbrevOff = d32(p + 8); q = p + 12; }
    else { abbrevOff = d32(p + 6); addrSize = buf[p + 10]; q = p + 11; }
    const firstDie = q; // start of the root DIE, i.e. end of the CU header
    const { map } = getAbbrev(abbrevOff);
    // root DIE
    let code; [code, q] = uleb(q);
    const attrs = map[code] || [];
    let name = '?', stmtList = null, stmtListPos = 0;
    for (const [at, form] of attrs) {
      const r = advanceForm(form, q, addrSize, 4);
      if (at === 0x03) { // DW_AT_name
        if (form === 0x0e && dstr) name = readStr(dstr, d32(r.valPos));
        else if (form === 0x08) name = buf.toString('utf8', r.valPos, r.next - 1);
      } else if (at === 0x10 && (form === 0x17 || form === 0x06)) { // DW_AT_stmt_list
        stmtList = d32(r.valPos); stmtListPos = r.valPos;
      }
      q = r.next;
    }
    cus.push({ cs, next, ver, addrSize, abbrevOff, firstDie, name, stmtList, stmtListPos, size: next - cs });
    p = next;
  }
  return { cus, di, da, dstr };
}

// --list-cu: print CUs and exit.
if (opts.listCu) {
  const { cus } = parseCUs();
  cus.sort((a, b) => b.size - a.size);
  console.log(`${inPath}: ${cus.length} compilation units (largest first)\n`);
  for (const c of cus) console.log(`  ${(c.size / 1024).toFixed(1).padStart(9)} KB  ${c.name}`);
  const total = cus.reduce((s, c) => s + c.size, 0);
  console.log(`\n  total .debug_info: ${(total / 1024 / 1024).toFixed(2)} MB`);
  process.exit(0);
}

// Build trimmed .debug_info/.debug_abbrev/.debug_str keeping only matched CUs.
const replacements = {}; // section name -> Buffer
let keptCuNames = null;
if (opts.onlyCu.length) {
  const { cus, di, da, dstr } = parseCUs();
  const selected = cus.filter((c) => opts.onlyCu.some((m) => c.name.includes(m)));
  if (!selected.length) fail(`--only-cu matched no compilation unit (try --list-cu). patterns: ${opts.onlyCu.join(', ')}`);
  keptCuNames = selected.map((c) => c.name);

  // Collect per-CU field references (strp offsets, ref_addr targets) by walking
  // every DIE. Also gather the distinct abbrev tables the CUs use.
  const strOffsets = new Set();       // old .debug_str offsets referenced
  const refAddrFields = [];           // {cuIndex, absPos, target(section-rel)}
  const strpFields = [];              // {cuIndex, absPos, oldOff}
  let usesLineStrp = false;
  const abbrevTables = new Map();     // oldAbbrevOff -> {bytes}
  const diBase = di.offset;

  selected.forEach((cu, ci) => {
    if (!abbrevTables.has(cu.abbrevOff)) {
      const t = parseAbbrevTable(da.offset + cu.abbrevOff);
      abbrevTables.set(cu.abbrevOff, { bytes: buf.subarray(da.offset + cu.abbrevOff, t.endAbs) });
    }
    const { map } = parseAbbrevTable(da.offset + cu.abbrevOff);
    let q = cu.firstDie;
    while (q < cu.next) {
      let code; [code, q] = uleb(q);
      if (code === 0) continue;
      const attrs = map[code];
      if (!attrs) fail('corrupt DWARF: unknown abbrev code in ' + cu.name);
      for (const [, form] of attrs) {
        const r = advanceForm(form, q, cu.addrSize, 4);
        if (r.form === 0x0e && dstr) { const off = d32(r.valPos); strOffsets.add(off); strpFields.push({ ci, absPos: r.valPos, oldOff: off }); }
        else if (r.form === 0x1f) usesLineStrp = true;
        else if (r.form === 0x10) refAddrFields.push({ ci, absPos: r.valPos, target: d32(r.valPos) - diBase });
        q = r.next;
      }
    }
  });

  // Reject cross-CU references into CUs we are dropping — we cannot relocate
  // those safely, and a dangling ref would give GDB wrong/garbage types.
  const selRanges = selected.map((c) => [c.cs - diBase, c.next - diBase]);
  const external = refAddrFields.filter((f) => !selRanges.some(([a, b]) => f.target >= a && f.target < b));
  if (external.length) {
    fail(`selected CU(s) contain ${external.length} reference(s) into other CUs; ` +
         `broaden --only-cu to include the referenced files (or omit --only-cu).`);
  }

  // Build trimmed .debug_str (only referenced strings) + old->new offset map.
  const strMap = new Map();
  let newStr = Buffer.alloc(0);
  if (dstr && strOffsets.size) {
    const parts = []; let cursor = 0;
    for (const off of strOffsets) {
      const s = readStr(dstr, off);
      const bytes = Buffer.from(s + '\0', 'utf8');
      strMap.set(off, cursor);
      parts.push(bytes); cursor += bytes.length;
    }
    newStr = Buffer.concat(parts);
  }
  if (usesLineStrp && byName['.debug_line_str']) {
    // Some names live in .debug_line_str; keep it whole rather than rewrite.
    replacements['.debug_line_str'] = buf.subarray(
      byName['.debug_line_str'].offset,
      byName['.debug_line_str'].offset + byName['.debug_line_str'].size);
  }

  // Build trimmed .debug_abbrev (only the tables used) + old->new offset map.
  const abbrevMap = new Map();
  const abbrevParts = []; let acursor = 0;
  for (const [oldOff, { bytes }] of abbrevTables) {
    abbrevMap.set(oldOff, acursor);
    abbrevParts.push(bytes); acursor += bytes.length;
  }
  const newAbbrev = Buffer.concat(abbrevParts);

  // Build trimmed .debug_info: concatenate selected CUs, then patch each CU's
  // abbrev_offset, its strp fields, and any (intra-set) ref_addr fields.
  const newStarts = [];
  let total = 0;
  for (const c of selected) { newStarts.push(total); total += c.size; }
  const newInfo = Buffer.alloc(total);
  selected.forEach((cu, ci) => {
    const ns = newStarts[ci];
    buf.copy(newInfo, ns, cu.cs, cu.next);
    // patch abbrev_offset in the CU header
    const aoPos = (cu.ver >= 5 ? cu.cs + 8 : cu.cs + 6) - cu.cs + ns;
    wr32(newInfo, aoPos, abbrevMap.get(cu.abbrevOff));
  });
  for (const f of strpFields) wr32(newInfo, f.absPos - selected[f.ci].cs + newStarts[f.ci], strMap.get(f.oldOff));
  for (const f of refAddrFields) {
    // find containing selected CU (section-relative), remap to new section offset
    for (let k = 0; k < selRanges.length; k++) {
      const [a, b] = selRanges[k];
      if (f.target >= a && f.target < b) {
        wr32(newInfo, f.absPos - selected[f.ci].cs + newStarts[f.ci], f.target - a + newStarts[k]);
        break;
      }
    }
  }

  // Trim .debug_line to only the selected CUs' line programs (needed for
  // source-line breakpoints). Each CU's DW_AT_stmt_list points at a
  // self-contained line program whose length is in its own header (DWARF v4);
  // extract that slice and repoint stmt_list. v5 line headers reference other
  // sections, so there we keep .debug_line whole instead.
  const dl = byName['.debug_line'];
  const lineWanted = !matchesAny('.debug_line', LEVELS[opts.level]);
  if (dl && lineWanted && selected.every((c) => c.ver < 5)) {
    const lineMap = new Map(); const parts = []; let lc = 0;
    for (const cu of selected) {
      if (cu.stmtList == null || lineMap.has(cu.stmtList)) continue;
      const progLen = 4 + d32(dl.offset + cu.stmtList);
      parts.push(buf.subarray(dl.offset + cu.stmtList, dl.offset + cu.stmtList + progLen));
      lineMap.set(cu.stmtList, lc); lc += progLen;
    }
    selected.forEach((cu, ci) => {
      if (cu.stmtList != null) wr32(newInfo, cu.stmtListPos - cu.cs + newStarts[ci], lineMap.get(cu.stmtList));
    });
    replacements['.debug_line'] = Buffer.concat(parts);
  }

  replacements['.debug_info'] = newInfo;
  replacements['.debug_abbrev'] = newAbbrev;
  if (dstr) replacements['.debug_str'] = newStr;
}

// ===========================================================================
//  Per-section keep decision
// ===========================================================================
const levelDrop = LEVELS[opts.level].concat(opts.onlyCu.length ? ['.debug_aranges'] : []);
for (const s of secs) {
  const isAlloc = (s.flags & SHF_ALLOC) !== 0;
  const hasBytes = s.type !== SHT_NULL && s.type !== SHT_NOBITS && s.size > 0;
  const isCore = s.type === SHT_SYMTAB || s.type === SHT_STRTAB;

  let wanted = hasBytes && !isAlloc;
  if (wanted && !isCore && matchesAny(s.name, levelDrop)) wanted = false;
  if (wanted === false && matchesAny(s.name, opts.keep)) wanted = hasBytes && !isAlloc;
  if (matchesAny(s.name, opts.drop) && !isCore) wanted = false;

  // A trimmed replacement keeps the section (unless a level/drop excluded it).
  if (replacements[s.name] && wanted) s.replace = replacements[s.name];

  s.keepContent = wanted;
  s.contentSize = s.replace ? s.replace.length : s.size;
  s.newType = isAlloc && s.type !== SHT_NOBITS ? SHT_NOBITS : s.type;
}

// --- --list: report and exit without writing -------------------------------
const kb = (n) => (n / 1024).toFixed(1).padStart(9) + ' KB';
if (opts.list) {
  console.log(`${inPath}  (level=${opts.level}${opts.onlyCu.length ? ', only-cu=' + opts.onlyCu.join('|') : ''})\n`);
  console.log('  KEEP  SIZE          SECTION');
  let kept = 0, keptBytes = 0;
  for (const s of secs) {
    if (!s.name) continue;
    const mark = s.keepContent ? '  ✓ ' : '  · ';
    const tag = s.replace ? '  (trimmed)' : '';
    console.log(`${mark}${kb(s.contentSize)}   ${s.name}${tag}`);
    if (s.keepContent) { kept++; keptBytes += s.contentSize; }
  }
  console.log(`\n  would keep ${kept} section(s), ~${(keptBytes / 1024 / 1024).toFixed(2)} MB of content`);
  process.exit(0);
}

// --- lay out the new file ---------------------------------------------------
let cursor = EH.size;
for (const s of secs) {
  if (!s.keepContent) { s.newOffset = 0; continue; }
  const align = s.align > 1 ? s.align : 1;
  if (cursor % align !== 0) cursor += align - (cursor % align);
  s.newOffset = cursor;
  cursor += s.contentSize;
}
const shtAlign = is64 ? 8 : 4;
if (cursor % shtAlign !== 0) cursor += shtAlign - (cursor % shtAlign);
const newShoff = cursor;
const out = Buffer.alloc(newShoff + shnum * shentsize);

buf.copy(out, 0, 0, EH.size);
wrN(out, EH.shoff, newShoff);
wrN(out, EH.phoff, 0);
wr16(out, EH.phnum, 0);
wr16(out, EH.phentsize, 0);

for (const s of secs) {
  if (!s.keepContent) continue;
  if (s.replace) s.replace.copy(out, s.newOffset);
  else buf.copy(out, s.newOffset, s.offset, s.offset + s.size);
}

for (let i = 0; i < shnum; i++) {
  const s = secs[i];
  const dst = newShoff + i * shentsize;
  s.raw.copy(out, dst);
  wr32(out, dst + SH.type, s.newType);
  wrN(out, dst + SH.offset, s.keepContent ? s.newOffset : 0);
  if (s.replace) wrN(out, dst + SH.size, s.contentSize); // trimmed content is smaller
  const isAlloc = (s.flags & SHF_ALLOC) !== 0;
  if (!s.keepContent && !isAlloc && s.type !== SHT_NULL) wrN(out, dst + SH.size, 0);
}

fs.writeFileSync(outPath, out);

// --- report -----------------------------------------------------------------
const pct = ((1 - out.length / buf.length) * 100).toFixed(1);
const mb = (n) => (n / (1024 * 1024)).toFixed(2) + ' MB';
console.log(`${inPath}  ->  ${outPath}   (level=${opts.level}${opts.onlyCu.length ? ', only-cu' : ''})`);
console.log(`  ${mb(buf.length)}  ->  ${mb(out.length)}  (${pct}% smaller)`);
console.log(`  kept ${secs.filter((s) => s.keepContent).length} section(s) of ${shnum}`);
if (keptCuNames) {
  console.log(`  kept ${keptCuNames.length} compilation unit(s):`);
  for (const n of keptCuNames) console.log(`    - ${n}`);
}
