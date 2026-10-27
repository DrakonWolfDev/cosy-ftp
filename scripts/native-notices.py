"""Generate notices and a matching source archive from Cargo's locked resolution.

Run before packaging. Missing upstream notices are fatal; supplements are copied
verbatim from the crate's recorded upstream revision (see their provenance JSON).
"""
import io
import json
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import hashlib
import tomllib

ROOT = Path(__file__).resolve().parents[1]


def run(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True, encoding="utf-8")


def generate():
    platform = "windows" if sys.platform == "win32" else "linux"
    target = "x86_64-pc-windows-msvc" if platform == "windows" else "x86_64-unknown-linux-gnu"
    version = json.loads((ROOT / "package.json").read_text())["version"]
    metadata = json.loads(run("cargo", "metadata", "--locked", "--format-version", "1",
                              "--manifest-path", "src-tauri/Cargo.toml", "--filter-platform", target))
    output = ROOT / "build"
    output.mkdir(exist_ok=True)
    stage = ROOT / ".test-artifacts" / "distribution"
    stage.mkdir(parents=True, exist_ok=True)
    archive = stage / f"cosy-ftp-{version}-{platform}-sources.tar.gz"
    records = []
    locked = {(p["name"], p["version"]): p.get("checksum") for p in
              tomllib.loads((ROOT / "src-tauri/Cargo.lock").read_text())["package"]}
    notices = [f"Cosy FTP {version} — native dependency notices ({target})",
               f"Matching sources: https://github.com/DrakonWolfDev/cosy-ftp/releases/tag/v{version}",
               "Download the platform sources archive alongside the installers. Original licences remain applicable."]
    with tarfile.open(archive, "w:gz") as tar:
        # Include the exact tracked build inputs, including uncommitted version preparation.
        for name in run("git", "ls-files").splitlines():
            file = ROOT / name
            if file.is_file():
                tar.add(file, arcname=f"cosy-ftp/{name}", recursive=False)
        for package in sorted(metadata["packages"], key=lambda p: (p["name"], p["version"])):
            if not package.get("source"):
                continue
            directory = Path(package["manifest_path"]).parent
            label = f"{package['name']}-{package['version']}"
            files = sorted(f for f in directory.rglob("*") if f.is_file() and
                           re.match(r"^(licen[cs]e|copying|notice|copyright)([._-]|$)", f.name, re.I))
            supplement = ROOT / "build" / "native-license-supplements" / label
            extra = sorted(f for f in supplement.glob("*") if f.is_file() and f.suffix != ".json")
            if not files and not extra:
                raise RuntimeError(f"No upstream licence text for {label}")
            notices.append(f"\n{'=' * 72}\n{label}\nLicence: {package.get('license')}\nUpstream: {package.get('repository')}")
            for file in files + extra:
                notices.append(f"\n--- {file.relative_to(directory) if file in files else file.name} ---\n" +
                               file.read_text(encoding="utf-8", errors="replace"))
            # Registry archives preserve the exact shipped source bytes/checksums and
            # avoid rewriting tens of thousands of files on Windows.
            crate = directory.parents[2] / "cache" / directory.parent.name / f"{label}.crate"
            if not crate.is_file():
                raise RuntimeError(f"Missing locked registry source archive: {crate}")
            checksum = hashlib.sha256(crate.read_bytes()).hexdigest()
            if checksum != locked[(package["name"], package["version"])]:
                raise RuntimeError(f"Registry source checksum does not match Cargo.lock: {label}")
            tar.add(crate, arcname=f"cargo-sources/{crate.name}", recursive=False)
            tar.add(directory / ".cargo-checksum.json", arcname=f"cargo-checksums/{label}.json", recursive=False)
            if extra:
                tar.add(supplement, arcname=f"upstream-notices/{label}")
            records.append({"name": package["name"], "version": package["version"],
                            "license": package.get("license"), "source": package["source"],
                            "repository": package.get("repository"), "source_sha256": checksum})
        # Preserve frontend dependency sources too, without shipping build-tool binaries.
        for name in ("react", "react-dom", "scheduler", "lucide-react", "@tauri-apps/api"):
            tar.add(ROOT / "node_modules" / name, arcname=f"frontend-sources/{name}")
        instructions = ("Cosy FTP source and dependency sources\n\n"
                        "See cosy-ftp/README.md for native prerequisites and build commands.\n"
                        "cargo-sources contains the exact unmodified registry .crate archives used for this target, including nested native sources. Each .crate is a gzip-compressed tar archive.\n"
                        "For offline native sources, extract each .crate into a vendor/ directory; each archive already has a name-version root. Copy cargo-checksums/name-version.json to vendor/name-version/.cargo-checksum.json.\n"
                        "In cosy-ftp/.cargo/config.toml set [source.crates-io] replace-with = 'vendored-sources' and [source.vendored-sources] directory = '../vendor'. Build with Cargo --offline --locked for the supplied target.\n"
                        "Install frontend/build tooling with npm ci using the included package-lock.json.\n"
                        "Linux AppImage system-library sources, package versions and Debian build recipes are in the separate linux-system-sources archive.\n"
                        "All dependency licences and notices are preserved with their source trees.\n")
        info = tarfile.TarInfo("SOURCE-README.txt")
        content = instructions.encode()
        info.size = len(content)
        tar.addfile(info, io.BytesIO(content))
    text = "\n".join(notices) + "\n"
    (output / "NATIVE_THIRD_PARTY_NOTICES.txt").write_text(text, encoding="utf-8")
    (stage / f"NATIVE_NOTICES_{platform}.txt").write_text(text, encoding="utf-8")
    (stage / f"native-inventory-{platform}.json").write_text(json.dumps(records, indent=2) + "\n")
    print(f"{len(records)} native source packages and notices prepared: {archive}")


if __name__ == "__main__":
    generate()
