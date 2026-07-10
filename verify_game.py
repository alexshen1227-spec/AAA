"""Fast, dependency-free verification for The Wilds of Aerwyn.

Usage:
    python verify_game.py          # source, graph, DOM and asset checks
    python verify_game.py --build  # also rebuild and inspect the standalone HTML
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import struct
import subprocess
import sys


ROOT = pathlib.Path(__file__).resolve().parent
SRC = ROOT / "src"
IMPORT_RE = re.compile(r"(?:from\s+|import\s*)['\"]([^'\"]+)['\"]")
ASSET_RE = re.compile(
    r"['\"](assets/[^'\"]+\.(?:glb|gltf|bin|png|jpg|jpeg|webp|ogg|mp3|wav))['\"]",
    re.I,
)
ID_RE = re.compile(r"\bid=['\"]([^'\"]+)['\"]")
GET_ID_RE = re.compile(r"(?:getElementById|this\.el)\(['\"]([^'\"]+)['\"]\)")


class Checks:
    def __init__(self) -> None:
        self.failures: list[str] = []
        self.passes: list[str] = []

    def require(self, condition: bool, message: str) -> None:
        (self.passes if condition else self.failures).append(message)

    def run(self, build: bool) -> int:
        js_files = sorted(SRC.glob("*.js"))
        self.require(bool(js_files), "JavaScript source files discovered")

        for path in js_files:
            proc = subprocess.run(
                ["node", "--check", str(path)],
                cwd=ROOT,
                capture_output=True,
                text=True,
            )
            self.require(proc.returncode == 0, f"syntax: {path.relative_to(ROOT)}")
            if proc.returncode:
                self.failures.append((proc.stderr or proc.stdout).strip())

        # Resolve the local module graph without executing WebGL code.
        missing_imports: list[str] = []
        for path in js_files:
            source = path.read_text(encoding="utf-8")
            for spec in IMPORT_RE.findall(source):
                if not spec.startswith("."):
                    continue
                target = (path.parent / spec).resolve()
                if not target.is_file():
                    missing_imports.append(f"{path.name}: {spec}")
        self.require(not missing_imports, "all relative module imports resolve")
        self.failures.extend(f"missing import {item}" for item in missing_imports)

        # Every static DOM lookup should have a matching element in index.html.
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        ids = set(ID_RE.findall(html))
        looked_up: set[str] = set()
        for path in js_files:
            looked_up.update(GET_ID_RE.findall(path.read_text(encoding="utf-8")))
        missing_ids = sorted(looked_up - ids)
        self.require(not missing_ids, "all static DOM lookups resolve")
        self.failures.extend(f"missing DOM id #{item}" for item in missing_ids)

        # Runtime manifests are the packaging contract.
        manifest_text = (SRC / "assets.js").read_text(encoding="utf-8")
        manifest_text += "\n" + (SRC / "sfx-manifest.js").read_text(encoding="utf-8")
        assets = sorted(set(ASSET_RE.findall(manifest_text)))
        missing_assets = [item for item in assets if not (ROOT / item).is_file()]
        self.require(not missing_assets, f"all {len(assets)} runtime assets exist")
        self.failures.extend(f"missing asset {item}" for item in missing_assets)

        bad_glbs: list[str] = []
        for rel in (item for item in assets if item.lower().endswith(".glb")):
            data = (ROOT / rel).read_bytes()
            valid = len(data) >= 12 and data[:4] == b"glTF"
            if valid:
                version, declared = struct.unpack_from("<II", data, 4)
                valid = version == 2 and declared == len(data)
            if not valid:
                bad_glbs.append(rel)
        self.require(not bad_glbs, "all GLB headers and declared lengths are valid")
        self.failures.extend(f"invalid GLB {item}" for item in bad_glbs)

        if build:
            proc = subprocess.run(
                [sys.executable, "build_standalone.py"],
                cwd=ROOT,
                capture_output=True,
                text=True,
            )
            self.require(proc.returncode == 0, "standalone build succeeds")
            if proc.returncode:
                self.failures.append((proc.stderr or proc.stdout).strip())
            else:
                standalone = (ROOT / "WildsOfAerwyn.html").read_text(encoding="utf-8")
                match = re.search(r"window\.__ASSET_DATA=(\{.*?\});</script>", standalone)
                embedded = json.loads(match.group(1)) if match else {}
                self.require(set(embedded) == set(assets),
                             f"standalone embeds all {len(assets)} runtime assets")
                self.require("import 'g/main'" in standalone,
                             "standalone imports the embedded entry module")

        for message in self.passes:
            print(f"PASS  {message}")
        for message in self.failures:
            print(f"FAIL  {message}", file=sys.stderr)
        print(f"\n{len(self.passes)} checks passed; {len(self.failures)} failed")
        return 1 if self.failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build", action="store_true", help="rebuild and inspect WildsOfAerwyn.html")
    args = parser.parse_args()
    return Checks().run(args.build)


if __name__ == "__main__":
    raise SystemExit(main())
