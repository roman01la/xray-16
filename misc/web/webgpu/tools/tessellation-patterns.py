#!/usr/bin/env python3
"""Generate stock factor patterns from an explicitly supplied Microsoft reference source directory.
Download tessellator.hpp/.cpp from
https://microsoft.github.io/DirectX-Specs/d3d/archive/images/d3d11/
No network access is performed by this script. The supplied files are not changed.
"""
import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('reference', type=Path)
parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'tessellation-patterns.js')
args = parser.parse_args()
with tempfile.TemporaryDirectory(prefix='xray-tess-pattern-') as temporary:
    root = Path(temporary)
    shutil.copy(args.reference / 'tessellator.hpp', root)
    source = (args.reference / 'tessellator.cpp').read_text(encoding='cp1252')
    # Avoid libc++ overload conflicts without changing reference calculations.
    for name in ('fmin', 'fmax'):
        source = re.sub(r'\b' + name + r'\b', 'reference_' + name, source)
    (root / 'tessellator.cpp').write_text(source)
    (root / 'main.cpp').write_text(r'''
#include <cstdio>
#include "tessellator.hpp"
int main() {
 CHWTessellator t; puts("{");
 for(int n=1;n<=8;n*=2) {
  t.Init(D3D11_TESSELLATOR_PARTITIONING_INTEGER,D3D11_TESSELLATOR_OUTPUT_TRIANGLE_CCW);
  t.TessellateTriDomain(n,n,n,n);
  printf("\"%d\":{\"points\":[",n);
  for(int i=0;i<t.GetPointCount();i++) { auto p=t.GetPoints()[i];
   printf("%s[%.9g,%.9g,%.9g]",i?",":"",p.u,p.v,1-p.u-p.v); }
  printf("],\"indices\":[");
  for(int i=0;i<t.GetIndexCount();i++)printf("%s%d",i?",":"",t.GetIndices()[i]);
  printf("]}%s\n",n<8?",":"");
 } puts("}");
}
''')
    subprocess.run(['c++', '-std=c++17', '-O2', '-fno-strict-aliasing', str(root/'main.cpp'),
                    str(root/'tessellator.cpp'), '-o', str(root/'generate')], check=True)
    patterns = json.loads(subprocess.check_output([str(root/'generate')]))
    args.output.write_text('// Generated domain coordinates/connectivity from Microsoft D3D11 reference tessellator.\n'
                          '// Regenerate with tools/tessellation-patterns.py; data only, no reference implementation bundled.\n'
                          'export const tessellationPatterns = ' + json.dumps(patterns, separators=(',', ':')) + ';\n')
