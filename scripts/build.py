#!/usr/bin/env python3
"""Build the unsigned SynoUsage DSM package and offline demonstration."""
import argparse
import base64
import gzip
import hashlib
import io
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import struct
import subprocess
import tarfile
import zlib

ROOT = Path(__file__).resolve().parents[1]

def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))

def pixel(x, y):
    # Same geometry and palette as assets/synousage.svg, rasterized with antialiasing.
    cx = min(max(x, 16), 48); cy = min(max(y, 16), 48)
    if not (3 <= x <= 61 and 3 <= y <= 61 and (x-cx)**2+(y-cy)**2 <= 169):
        return (0, 0, 0, 0)
    t = (y-3)/58
    color = (round(7+15*t), round(137-65*t), round(235-41*t), 255)
    if (x-30)**2+(y-33)**2 <= 18**2 and not (x >= 30 and y <= 33):
        return (255,255,255,255)
    if x >= 34 and y <= 31 and (x-33)**2+(y-32)**2 <= 18**2:
        return (168,235,255,255)
    return color

def icon(size):
    pixels = bytearray()
    for y in range(size):
        pixels.append(0)
        for x in range(size):
            points = [pixel((x+(sx+.5)/3)*64/size, (y+(sy+.5)/3)*64/size) for sy in range(3) for sx in range(3)]
            pixels.extend(round(sum(p[c] for p in points)/9) for c in range(4))
    header = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(bytes(pixels), 9)) + chunk(b'IEND', b'')

def archive(files):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode='w', format=tarfile.USTAR_FORMAT) as tar:
        dirs = set()
        for name in files:
            path = PurePosixPath(name)
            if path.is_absolute() or '..' in path.parts: raise ValueError('Unsafe archive path: ' + name)
            dirs.update(str(p) for p in path.parents if str(p) != '.')
        for name in sorted(dirs):
            info = tarfile.TarInfo(name + '/'); info.type = tarfile.DIRTYPE; info.mode = 0o755
            info.uid = info.gid = info.mtime = 0; info.uname = info.gname = 'root'; tar.addfile(info)
        for name, (data, mode) in sorted(files.items()):
            info = tarfile.TarInfo(name); info.size = len(data); info.mode = mode
            info.uid = info.gid = info.mtime = 0; info.uname = info.gname = 'root'; tar.addfile(info, io.BytesIO(data))
    return out.getvalue()

def read(path):
    data = path.read_bytes()
    return data.replace(b'\r\n', b'\n') if path.suffix.lower() in ('.js','.css','.html','.svg','.json') or not path.suffix else data

def preview():
    ui = ROOT / 'ui'
    html = (ui / 'index.html').read_text(encoding='utf-8')
    def style(m):
        return '<style>' + (ui / m.group(1)).read_text(encoding='utf-8') + '</style>'
    html = re.sub(r'<link\s+rel="stylesheet"\s+href="([^"]+)"\s*/?>', style, html)
    def script(m):
        path = ui / m.group(1)
        source = path.read_text(encoding='utf-8') if path.exists() else ('window.SynoUsageBuild={};' if path.name == 'task-build.js' else None)
        if source is None: raise ValueError('Missing preview script: ' + str(path))
        return '<script>' + source.replace('</script', '<\\/script') + '</script>'
    html = re.sub(r'<script\s+(?:defer\s+)?src="([^"]+)"\s*></script>', script, html)
    svg = base64.b64encode((ui / 'assets/synousage.svg').read_bytes()).decode('ascii')
    html = html.replace('assets/synousage.svg', 'data:image/svg+xml;base64,' + svg)
    return html.encode('utf-8')

def generate_icons():
    """Refresh the checked-in DSM and package icons after an icon design change."""
    package = ROOT / "package"
    images = package / "ui" / "images"
    images.mkdir(parents=True, exist_ok=True)
    for size in (16, 24, 32, 48, 64, 72, 128, 256):
        data = icon(size)
        (images / f"icon_{size}.png").write_bytes(data)
        if size in (64, 256):
            (package / ("PACKAGE_ICON.PNG" if size == 64 else "PACKAGE_ICON_256.PNG")).write_bytes(data)


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--go', default='go'); parser.add_argument('--icons', action='store_true', help='Regenerate checked-in icons and exit'); args = parser.parse_args()
    if args.icons:
        generate_icons()
        return
    build = ROOT / 'build'; dist = ROOT / 'dist'; build.mkdir(exist_ok=True); dist.mkdir(exist_ok=True)
    exe = build / 'synousage'
    subprocess.run([args.go, 'build', '-trimpath', '-buildvcs=false', '-ldflags=-s -w', '-o', str(exe), './cmd/synousage'], cwd=ROOT, env=dict(os.environ, GOOS='linux', GOARCH='amd64', GOAMD64='v1', CGO_ENABLED='0'), check=True)
    binary = exe.read_bytes()
    if len(binary) > 16 << 20:
        raise ValueError('The collector exceeds the task script copy limit')
    if binary[:6] != b'\x7fELF\x02\x01' or struct.unpack_from('<H',binary,18)[0] != 62: raise ValueError('Expected Linux amd64 ELF')
    off = struct.unpack_from('<Q',binary,32)[0]; sz, count = struct.unpack_from('<HH',binary,54)
    if any(struct.unpack_from('<I',binary,off+i*sz)[0] == 3 for i in range(count)): raise ValueError('Expected static binary')
    package = ROOT / 'package'; ui = ROOT / 'ui'
    info = read(package / 'INFO')
    version = re.search(rb'^version="([0-9]+\.[0-9]+\.[0-9]+-[0-9]+)"$', info, re.M)
    if not version:
        raise ValueError('Missing package version in INFO')
    version = version[1].decode('ascii')
    binary_hash = hashlib.sha256(binary).hexdigest()
    stamp = (version + '-' + binary_hash[:12]).encode('ascii')
    if json.loads((package/'conf/privilege').read_text()) != {'defaults':{'run-as':'package'}}: raise ValueError('Unexpected privileges')
    payload = {}
    for base in (ui, package/'ui'):
        for p in sorted(base.rglob('*')):
            if p.is_file():
                name = 'ui/' + p.relative_to(base).as_posix()
                if name in payload or name == 'ui/task-build.js': raise ValueError('Duplicate or generated UI asset: ' + name)
                data = read(p)
                if name == 'ui/index.html':
                    data = re.sub(rb'((?:href|src)="[a-zA-Z0-9/_.-]+)"', rb'\1?v=' + stamp + b'"', data)
                if name == 'ui/SynoUsage.js':
                    data = data.replace(b'__SYNOUSAGE_BUILD__', stamp)
                if name == 'ui/config':
                    config = json.loads(data)
                    for definitions in config.values():
                        for definition in definitions.values():
                            definition['version'] = version
                    data = (json.dumps(config, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
                payload[name] = (data, 0o644)
    payload['ui/task-build.js'] = (('window.SynoUsageBuild=' + json.dumps({'collectorSHA256':binary_hash, 'version':version}, separators=(',',':')) + ';\n').encode(), 0o644)
    if b'task-build.js' not in payload['ui/index.html'][0]: raise ValueError('index.html must load task-build.js')
    payload['bin/synousage'] = (binary, 0o755); payload['ui/api.cgi'] = (binary, 0o755)
    for size in (16, 24, 32, 48, 64, 72, 128, 256):
        if f"ui/images/icon_{size}.png" not in payload:
            raise ValueError(f"Missing DSM icon: ui/images/icon_{size}.png; regenerate with --icons")
    raw = archive(payload); output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, mode='wb', mtime=0, filename='', compresslevel=9) as gz: gz.write(raw)
    tgz = output.getvalue(); info += f'checksum="{hashlib.md5(tgz).hexdigest()}"\n'.encode()
    files = {'INFO':(info,0o644), 'package.tgz':(tgz,0o644), 'PACKAGE_ICON.PNG':((package/'PACKAGE_ICON.PNG').read_bytes(),0o644), 'PACKAGE_ICON_256.PNG':((package/'PACKAGE_ICON_256.PNG').read_bytes(),0o644)}
    for folder in ('conf','scripts'):
        for path in sorted((package/folder).rglob('*')):
            if not path.is_file():
                continue
            name = path.relative_to(package).as_posix()
            contents = read(path)
            if name == 'scripts/start-stop-status':
                placeholder = b'__SYNOUSAGE_COLLECTOR_SHA256__'
                if contents.count(placeholder) != 1:
                    raise ValueError('Collector checksum placeholder is missing or duplicated')
                contents = contents.replace(placeholder, binary_hash.encode('ascii'))
            files[name] = (contents, 0o755 if folder == 'scripts' else 0o644)
    if not all(name in files for name in ('scripts/preupgrade', 'scripts/postupgrade')):
        raise ValueError('DSM upgrades require preupgrade and postupgrade scripts')
    spk = dist / f'h5uSynoUsage-{version}-x86_64.spk'; spk.write_bytes(archive(files))
    digest = hashlib.sha256(spk.read_bytes()).hexdigest()
    spk.with_suffix('.spk.sha256').write_text(f'{digest}  {spk.name}\n',encoding='ascii')
    (dist/'SynoUsage-Vorschau.html').write_bytes(preview())
    print(f'SPK: {spk}\nSHA256: {digest}\nPreview: {dist / "SynoUsage-Vorschau.html"}')

if __name__ == '__main__': main()
