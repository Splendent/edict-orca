import fs from 'node:fs';
import path from 'node:path';

const identity=stat=>`${stat.dev}:${stat.ino}`;
// Folding unresolved names is conservative on case-sensitive filesystems too.
const fold=name=>name.normalize('NFC').toLowerCase();
function descriptor(file) {
  let target=path.resolve(file), missing=[];
  const visited=new Set();
  for (;;) {
    if (visited.has(target)) return null;
    visited.add(target);
    try {
      const real=fs.realpathSync(target),stat=fs.statSync(real,{bigint:true});
      if (missing.length&&!stat.isDirectory()) return null;
      const routes=[];
      let cursor=real,tail=missing.map(fold);
      for (;;) {
        routes.push({id:identity(fs.statSync(cursor,{bigint:true})),tail});
        const parent=path.dirname(cursor);
        if (parent===cursor) break;
        tail=[fold(path.basename(cursor)),...tail];cursor=parent;
      }
      return {real,stat,routes,exists:missing.length===0};
    } catch(error) {
      if (!['ENOENT','ENOTDIR'].includes(error.code)) return null;
      try {
        if (fs.lstatSync(target).isSymbolicLink()) {
          target=path.resolve(path.dirname(target),fs.readlinkSync(target),...missing);
          missing=[];continue;
        }
      } catch(linkError) { if (!['ENOENT','ENOTDIR'].includes(linkError.code)) return null; }
      const parent=path.dirname(target);
      if (parent===target) return null;
      missing.unshift(path.basename(target));target=parent;
    }
  }
}
export function geometry(root,names) {
  if (!names.length) return {ranges:[],unknown:false};
  if (!root || !fs.existsSync(root)) return {ranges:[],unknown:true};
  const result={ranges:[],unknown:false},visited=new Set();
  function descendants(directory,stat) {
    const id=identity(stat);
    if(visited.has(id)) return;
    visited.add(id);
    try {
      for(const name of fs.readdirSync(directory)) {
        const file=path.join(directory,name),child=fs.lstatSync(file,{bigint:true});
        if(child.isSymbolicLink()) { visit(file);continue; }
        // The selected directory's routes already cover ordinary descendants and future names.
        // Keep each descendant's identity for hard links and aliases reached through another parent.
        result.ranges.push([{id:identity(child),tail:[]}]);
        if(child.isDirectory()) descendants(file,child);
      }
    } catch { result.unknown=true; }
  }
  function visit(file) {
    const entry=descriptor(file);
    if (!entry) { result.unknown=true;return; }
    result.ranges.push(entry.routes);
    if(entry.exists&&entry.stat.isDirectory()) descendants(entry.real,entry.stat);
  }
  for(const name of names) {
    visit(name==='*'?root:path.resolve(root,name));
  }
  return result;
}
// Combines per-root geometries into one claim; physical identities keep roots comparable.
export function mergeGeometry(...parts) {
  return {ranges:parts.flatMap(x=>x.ranges),unknown:parts.some(x=>x.unknown)};
}
function prefix(a,b) { return a.length<=b.length&&a.every((x,i)=>x===b[i]); }
export function rangeOverlap(a,b) {
  if (!a.ranges.length&&!a.unknown||!b.ranges.length&&!b.unknown) return false;
  if (a.unknown||b.unknown) return true;
  return a.ranges.some(left=>b.ranges.some(right=>left.some(x=>right.some(y=>x.id===y.id&&(prefix(x.tail,y.tail)||prefix(y.tail,x.tail))))));
}
// Names each overlapping read/write dimension using the declared project-relative ranges, never the physical geometry.
const rootName=root=>String(root).replaceAll('\\','/').replace(/\/$/,'');
// Declared reads plus cross-root reads shown as <absolute root>/<range>.
const declaredReads=x=>[...(x.reads||[]),...(x.extraReads||[]).flatMap(e=>e.reads.map(r=>`${rootName(e.root)}/${r}`))];
const relName=name=>String(name).replaceAll('\\','/').replace(/^\.\//,'').replace(/\/+$/,'');
// Declared project reads that are strict ancestor directories of a declared write.
function coveringReads(reads,writes) {
  return (reads||[]).filter(dir=>dir!=='*'&&(writes||[]).some(file=>relName(file).startsWith(relName(dir)+'/')));
}
export function overlapDetails(candidate,other,label='在途') {
  const show=names=>names?.length?names.join(', '):'（未宣告）';
  const rows=[];let conservative=false;
  const check=(a,b,text)=>{
    if (!rangeOverlap(a,b)) return;
    rows.push(text);
    // Unresolved locations or unreadable trees cannot safely exclude an overlap.
    if (a?.unknown||b?.unknown) conservative=true;
  };
  check(candidate.physicalWrites,other.physicalWrites,`寫入/寫入：本次寫入 ${show(candidate.writes)}，${label}寫入 ${show(other.writes)}`);
  const before=rows.length;
  check(candidate.physicalWrites,other.physicalReads,`寫入/讀取：本次寫入 ${show(candidate.writes)}，${label}讀取 ${show(declaredReads(other))}`);
  const writeRead=rows.length>before;
  check(candidate.physicalReads,other.physicalWrites,`讀取/寫入：本次讀取 ${show(declaredReads(candidate))}，${label}寫入 ${show(other.writes)}`);
  const readWrite=rows.length>before+(writeRead?1:0);
  // A read of a whole directory blocks every write inside it, e.g. sibling output files in one shared folder.
  const hints=[...(writeRead?coveringReads(other.reads,candidate.writes):[]),...(readWrite?coveringReads(candidate.reads,other.writes):[])];
  if (hints.length) rows.push(`讀取目錄 ${[...new Set(hints)].join(', ')} 涵蓋另一方在該目錄內的寫入；若不需讀取那些輸出，雙方改列出實際要讀的檔案，不讀整個輸出目錄`);
  return conservative?[...rows,'實體範圍未確認（工作樹位置未知或目錄無法完整讀取），保守視為重疊']:rows;
}
