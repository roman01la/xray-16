import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

test('Clear Sky aiming reads evaluated poses without changing animation channels or callbacks', () => {
  const source = readFileSync(new URL('../../../src/xrGame/aimers_base_inline.h', import.meta.url), 'utf8');
  const start = source.indexOf('    static_assert');
  const end = source.indexOf('    u16 const root_bone_id');
  assert.ok(start > 0 && end > start);
  const directory = mkdtempSync(join(tmpdir(), 'cs-aiming-'));
  try {
    writeFileSync(join(directory, 'test.cpp'), `#include <cassert>
using u32=unsigned;using u16=unsigned short;
#define VERIFY(value) assert(value)
bool ClearSkyMode=true;
struct Fmatrix {
 int value=0;
 void mul_43(const Fmatrix& parent,const Fmatrix& local){value=parent.value+local.value;}
};
bool _valid(const Fmatrix& value){return value.value>=0;}
struct Kinematics {
 Fmatrix poses[5]={{10},{20},{30},{40},{50}};
 int reads=0;
 const Fmatrix& LL_GetTransform(u16 bone){++reads;assert(bone<5);return poses[bone];}
};
struct Aimer {
 Kinematics m_kinematics;
 Fmatrix m_start_transform{100};
 bool legacy=false;
 template<u32 bone_count0,u32 bone_count1>
 void fill_bones(const u32(&bones)[bone_count0],const u16(&bones_ids)[bone_count1],
                 Fmatrix(&local_bones)[bone_count1],Fmatrix(&global_bones)[bone_count1]) {
${source.slice(start, end)}
  legacy=true;
 }
};
int main(){
 Aimer aimer;
 const u32 wanted[]={1,3};const u16 ids[]={4,3,2,1,0};
 Fmatrix local[5],global[5];
 aimer.fill_bones(wanted,ids,local,global);
 assert(aimer.m_kinematics.reads==2&&!aimer.legacy);
 assert(local[1].value==40&&local[3].value==20);
 assert(global[1].value==140&&global[3].value==120);
 assert(local[0].value==0&&global[2].value==0);
 ClearSkyMode=false;aimer.fill_bones(wanted,ids,local,global);
 assert(aimer.legacy&&aimer.m_kinematics.reads==2);
}
`);
    const compiled = spawnSync('c++', ['-std=c++17', '-O2', join(directory, 'test.cpp'), '-o', join(directory, 'test')], {encoding:'utf8'});
    assert.equal(compiled.status, 0, compiled.stderr);
    const result = spawnSync(join(directory, 'test'), [], {encoding:'utf8'});
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, {recursive:true, force:true});
  }
});
