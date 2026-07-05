"""Build WildsOfAerwyn.html — a single self-contained file that runs from
a double-click (file://). Modules are embedded as base64 data: URLs and wired
together with an import map; relative imports are rewritten to bare
specifiers because data: modules cannot resolve relative paths.
"""
import base64, json, re, os

ROOT = os.path.dirname(os.path.abspath(__file__))

def read(p):
    with open(os.path.join(ROOT, p), 'r', encoding='utf-8') as f:
        return f.read()

def b64(data: bytes) -> str:
    return base64.b64encode(data).decode('ascii')

def js_data_url(src: str) -> str:
    return 'data:text/javascript;base64,' + b64(src.encode('utf-8'))

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

# ---- assemble html ---------------------------------------------------------
html = read('index.html')

# swap the import map
html = re.sub(
    r'<script type="importmap">.*?</script>',
    '<script type="importmap">\n' + json.dumps({'imports': imports}) + '\n</script>',
    html, flags=re.S)

# entry point becomes an inline import
html = html.replace('<script type="module" src="./src/main.js"></script>',
                    '<script type="module">import \'g/main\';</script>')

# inline the font
with open(os.path.join(ROOT, 'lib/fonts/cinzel-latin.woff2'), 'rb') as f:
    font_url = 'data:font/woff2;base64,' + b64(f.read())
html = html.replace("url('./lib/fonts/cinzel-latin.woff2')", f"url('{font_url}')")

# the standalone IS the file:// build — drop the warning trigger
html = html.replace("if (location.protocol === 'file:')", 'if (false)')

out = os.path.join(ROOT, 'WildsOfAerwyn.html')
with open(out, 'w', encoding='utf-8') as f:
    f.write(html)
print(f'built {out} ({os.path.getsize(out) / 1e6:.2f} MB, {len(modules)} modules)')
