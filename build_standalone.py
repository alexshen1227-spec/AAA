"""Build WildsOfAerwyn.html -- a genuinely self-contained file:// build.

JavaScript modules are embedded as data URLs and wired together with an import
map. Every model and audio file referenced by the runtime manifests is also
embedded in ``window.__ASSET_DATA``; ``src/assets.js`` transparently resolves
those data URLs instead of attempting file-protocol fetches.
"""
import base64, json, mimetypes, re, os

ROOT = os.path.dirname(os.path.abspath(__file__))

def read(p):
    with open(os.path.join(ROOT, p), 'r', encoding='utf-8') as f:
        return f.read()

def b64(data: bytes) -> str:
    return base64.b64encode(data).decode('ascii')

def js_data_url(src: str) -> str:
    return 'data:text/javascript;base64,' + b64(src.encode('utf-8'))

def file_data_url(rel_path: str) -> str:
    """Encode a repository-relative binary asset with a useful MIME type."""
    full_path = os.path.join(ROOT, *rel_path.split('/'))
    with open(full_path, 'rb') as f:
        data = f.read()
    mime = mimetypes.guess_type(rel_path)[0] or 'application/octet-stream'
    # Python/Windows does not consistently know the glTF binary MIME type.
    if rel_path.lower().endswith('.glb'):
        mime = 'model/gltf-binary'
    return f'data:{mime};base64,' + b64(data)

# ---- collect modules -------------------------------------------------------
modules = {}
for name in sorted(os.listdir(os.path.join(ROOT, 'src'))):
    if not name.endswith('.js'):
        continue
    src = read('src/' + name)
    # './noise.js' -> 'g/noise' (bare specifier, resolved by the import map)
    src = re.sub(r"from '\./([A-Za-z0-9_-]+)\.js'", r"from 'g/\1'", src)
    modules['g/' + name[:-3]] = src

imports = {'three': js_data_url(read('lib/three.module.js'))}
for key, src in modules.items():
    imports[key] = js_data_url(src)

# ---- collect runtime assets ------------------------------------------------
# Keep this manifest-driven rather than embedding the entire assets directory:
# source packs, Blender previews and license documents belong in the repository
# but are not required at runtime. Literal paths in the two runtime manifests
# are the authoritative distributable set.
asset_sources = read('src/assets.js') + '\n' + read('src/sfx-manifest.js')
asset_paths = sorted(set(re.findall(
    r"['\"](assets/[^'\"]+\.(?:glb|gltf|bin|png|jpg|jpeg|webp|ogg|mp3|wav))['\"]",
    asset_sources,
    flags=re.I,
)))
asset_data = {}
for rel_path in asset_paths:
    full_path = os.path.join(ROOT, *rel_path.split('/'))
    if not os.path.isfile(full_path):
        raise FileNotFoundError(f'runtime asset is missing: {rel_path}')
    asset_data[rel_path] = file_data_url(rel_path)

# ---- assemble html ---------------------------------------------------------
html = read('index.html')

# swap the import map
html = re.sub(
    r'<script type="importmap">.*?</script>',
    '<script type="importmap">\n' + json.dumps({'imports': imports}) + '\n</script>',
    html, flags=re.S)

# entry point becomes an inline import
html = html.replace('<script type="module" src="./src/main.js"></script>',
                    '<script>window.__ASSET_DATA=' +
                    json.dumps(asset_data, separators=(',', ':')) +
                    ';</script>\n<script type="module">import \'g/main\';</script>')

# inline the font
with open(os.path.join(ROOT, 'lib/fonts/cinzel-latin.woff2'), 'rb') as f:
    font_url = 'data:font/woff2;base64,' + b64(f.read())
html = html.replace("url('./lib/fonts/cinzel-latin.woff2')", f"url('{font_url}')")

# the standalone IS the file:// build — drop the warning trigger
html = html.replace("if (location.protocol === 'file:')", 'if (false)')

out = os.path.join(ROOT, 'WildsOfAerwyn.html')
with open(out, 'w', encoding='utf-8') as f:
    f.write(html)
print(f'built {out} ({os.path.getsize(out) / 1e6:.2f} MB, '
      f'{len(modules)} modules, {len(asset_data)} embedded assets)')
