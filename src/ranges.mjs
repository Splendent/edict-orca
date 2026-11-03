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
  let budget=2048;
  function visit(file) {
    if (--budget<0) { result.unknown=true;return; }
    const entry=descriptor(file);
    if (!entry) { result.unknown=true;return; }
    result.ranges.push(entry.routes);
    if (!entry.exists||!entry.stat.isDirectory()||visited.has(identity(entry.stat))) return;
    visited.add(identity(entry.stat));
    try {
      for(const child of fs.readdirSync(entry.real)) {
        visit(path.join(entry.real,child));
        if (budget<0) break;
      }
    } catch { result.unknown=true; }
  }
  for(const name of names) {
    if(name==='*') result.unknown=true;
    else visit(path.resolve(root,name));
  }
  return result;
}
function prefix(a,b) { return a.length<=b.length&&a.every((x,i)=>x===b[i]); }
export function rangeOverlap(a,b) {
  if (!a.ranges.length&&!a.unknown||!b.ranges.length&&!b.unknown) return false;
  if (a.unknown||b.unknown) return true;
  return a.ranges.some(left=>b.ranges.some(right=>left.some(x=>right.some(y=>x.id===y.id&&(prefix(x.tail,y.tail)||prefix(y.tail,x.tail))))));
}
