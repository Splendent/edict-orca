import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { geometry, mergeGeometry, rangeOverlap } from '../src/ranges.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'edict-geometry-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=(name,body='x')=>{
    const target=path.join(root,name);fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.writeFileSync(target,body);return target;
  };
  return {root,file};
}

for(const count of [552,593,14]) {
  test(`${count} declared reads remain known after a dependency tree exceeds 2048 entries`,t=>{
    const f=fixture(t);
    // Real reports used 23 dependency directories among 552/593 mostly exact source/public names.
    // W-010 used only 14 broader names, but a single dependency can exhaust the old shared budget.
    const packages=count===14?1:23;
    const names=Array.from({length:packages},(_,i)=>`node_modules/${i===0?'phaser':`package-${i}`}`);
    for(const name of names) fs.mkdirSync(path.join(f.root,name),{recursive:true});
    for(let i=0;i<2100;i++)f.file(`node_modules/phaser/src/file-${i}.js`);
    for(let i=packages;i<count;i++){const name=`public/input-${i}.png`;f.file(name);names.push(name);}
    const reads=geometry(f.root,names);
    assert.equal(names.length,count);
    assert.equal(reads.unknown,false);
    assert.ok(reads.ranges.length>2048);
    assert.equal(rangeOverlap(reads,geometry(f.root,['assets-src/independent-output'])),false);
    assert.equal(rangeOverlap(reads,geometry(f.root,['node_modules/phaser/src/new-file.js'])),true);
    assert.equal(rangeOverlap(reads,geometry(f.root,[names.at(-1)])),true);
    // Descendants carry one identity instead of repeating every physical ancestor route.
    assert.ok(reads.ranges.filter(routes=>routes.length===1).length>=2100);
  });
}

test('a known-root wildcard covers its tree without blocking a separate physical tree',t=>{
  const f=fixture(t);f.file('repo/.git/HEAD');f.file('repo/src/a.js');f.file('other/output.txt');
  const git=geometry(path.join(f.root,'repo/.git'),['*']);
  assert.equal(git.unknown,false);
  assert.equal(rangeOverlap(git,geometry(f.root,['repo/.git/refs/future'])),true);
  assert.equal(rangeOverlap(git,geometry(f.root,['repo/src/a.js'])),false);
  assert.equal(rangeOverlap(git,geometry(f.root,['other/output.txt'])),false);
  assert.equal(geometry(null,['*']).unknown,true);
});

test('large directory scans retain hard-link aliases beyond the former budget',t=>{
  const f=fixture(t);
  for(let i=0;i<2100;i++)f.file(`inputs/a-${i}.txt`);
  const outside=f.file('outside/linked.txt');
  fs.linkSync(outside,path.join(f.root,'inputs/z-hard-link.txt'));
  const reads=geometry(f.root,['inputs']);
  assert.equal(reads.unknown,false);
  assert.equal(rangeOverlap(reads,geometry(f.root,['outside/linked.txt'])),true);
  assert.equal(rangeOverlap(reads,geometry(f.root,['unrelated/new.txt'])),false);
});

test('directory junctions retain outside descendants and future target names without cycling',t=>{
  const f=fixture(t);f.file('inputs/local.txt');f.file('outside/existing.txt');
  fs.symlinkSync(path.join(f.root,'outside'),path.join(f.root,'inputs/alias'),process.platform==='win32'?'junction':'dir');
  fs.symlinkSync(path.join(f.root,'inputs'),path.join(f.root,'outside/back'),process.platform==='win32'?'junction':'dir');
  const reads=geometry(f.root,['inputs']);
  assert.equal(reads.unknown,false);
  assert.equal(rangeOverlap(reads,geometry(f.root,['outside/existing.txt'])),true);
  assert.equal(rangeOverlap(reads,geometry(f.root,['outside/future.txt'])),true);
  assert.equal(rangeOverlap(reads,geometry(f.root,['independent/new.txt'])),false);
});

test('a dangling link still claims its future physical target',t=>{
  const f=fixture(t);fs.mkdirSync(path.join(f.root,'inputs'));
  try { fs.symlinkSync(path.join(f.root,'outside/future.txt'),path.join(f.root,'inputs/link.txt')); }
  catch(error) { if(process.platform==='win32'&&error.code==='EPERM'){t.skip('file symlink privilege unavailable');return;}throw error; }
  const reads=geometry(f.root,['inputs']);
  assert.equal(reads.unknown,false);
  assert.equal(rangeOverlap(reads,geometry(f.root,['outside/future.txt'])),true);
});

test('unreadable descendants and unresolved roots remain conservatively unknown',t=>{
  const f=fixture(t);f.file('inputs/nested/a.txt');
  const readdir=fs.readdirSync;
  t.mock.method(fs,'readdirSync',(directory,...args)=>{
    if(directory===path.join(f.root,'inputs/nested'))throw Object.assign(new Error('denied'),{code:'EACCES'});
    return readdir(directory,...args);
  });
  const reads=geometry(f.root,['inputs']);
  assert.equal(reads.unknown,true);
  assert.equal(rangeOverlap(reads,geometry(f.root,['independent/new.txt'])),true);
  assert.equal(mergeGeometry(geometry(f.root,[]),geometry(null,['src'])).unknown,true);
});

test('an unresolved descendant identity keeps the directory unknown',t=>{
  const f=fixture(t);const denied=f.file('inputs/a.txt'),lstat=fs.lstatSync;
  t.mock.method(fs,'lstatSync',(file,...args)=>{
    if(file===denied)throw Object.assign(new Error('cannot inspect'),{code:'EACCES'});
    return lstat(file,...args);
  });
  assert.equal(geometry(f.root,['inputs']).unknown,true);
});
