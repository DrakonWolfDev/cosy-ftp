"""Inventory the actual AppImage payload and archive exact Ubuntu source packages.

Run on the same Ubuntu machine immediately after bundling, with deb-src enabled.
Fail rather than publish if a bundled ELF cannot be traced to its source.
"""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from urllib.request import urlopen
from urllib.parse import urlencode, urlparse, unquote

ROOT = Path(__file__).resolve().parents[1]


def output(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


def main():
    version = json.loads((ROOT / "package.json").read_text())["version"]
    bundle = ROOT / "src-tauri/target/release/bundle"
    if target := __import__("os").environ.get("CARGO_TARGET_DIR"):
        bundle = Path(target) / "release/bundle"
    images = list((bundle / "appimage").glob(f"*{version}*.AppImage"))
    if len(images) != 1:
        raise RuntimeError("Expected exactly one current AppImage in a clean bundle directory")
    image = images[0].resolve()
    stage = ROOT / ".test-artifacts/distribution"
    stage.mkdir(parents=True, exist_ok=True)
    records, packages = [], {}
    with tempfile.TemporaryDirectory(prefix="cosy-distribution-") as temp:
        temp = Path(temp)
        subprocess.run([str(image), "--appimage-extract"], cwd=temp, check=True, stdout=subprocess.DEVNULL)
        appdir = temp / "squashfs-root"
        seen = set()
        for file in sorted(appdir.rglob("*")):
            if not file.is_file() or file.resolve() in seen:
                continue
            seen.add(file.resolve())
            with file.open("rb") as stream:
                is_elf = stream.read(4) == b"\x7fELF"
            if not is_elf and not file.name.endswith(".gschema.xml"):
                continue
            relative = file.relative_to(appdir).as_posix()
            if file.name == "cosy-ftp":
                records.append({"file": relative, "source": "Cosy FTP and cargo-sources"})
                continue
            if relative == "AppRun.wrapped":
                records.append({"file": relative, "source": "AppImageKit", "sha256": hashlib.sha256(file.read_bytes()).hexdigest()})
                continue
            matches = output("dpkg-query", "-S", f"*/{file.name}").splitlines()
            owners = set()
            for match in matches:
                owner, _, installed_path = match.partition(": ")
                if Path(installed_path).is_file():
                    owners.add(owner)
            if len(owners) != 1:
                raise RuntimeError(f"Ambiguous or missing package owner for {relative}: {owners}")
            owner = owners.pop()
            installed = next(Path(line.partition(": ")[2]) for line in matches
                             if line.partition(": ")[0] == owner and Path(line.partition(": ")[2]).is_file())
            def build_id(path):
                match = re.search(r"Build ID: ([a-f0-9]+)", output("readelf", "-n", str(path)))
                if not match:
                    raise RuntimeError(f"ELF has no build ID: {path}")
                return match[1]
            identity = build_id(file) if is_elf else hashlib.sha256(file.read_bytes()).hexdigest()
            installed_identity = build_id(installed) if is_elf else hashlib.sha256(installed.read_bytes()).hexdigest()
            if identity != installed_identity:
                raise RuntimeError(f"Installed source version cannot be used for changed payload: {relative}")
            fields = output("dpkg-query", "-W", "-f=${binary:Package}\t${Version}\t${source:Package}\t${source:Version}", owner).split("\t")
            binary, binary_version, source, source_version = fields
            source = source or binary.split(":")[0]
            source_version = source_version or binary_version
            packages[binary] = {"binary": binary, "version": binary_version, "source": source, "source_version": source_version}
            records.append({"file": relative, "package": binary, "version": binary_version,
                            "source": source, "source_version": source_version, "build_id": identity if is_elf else None,
                            "sha256": hashlib.sha256(file.read_bytes()).hexdigest()})
        source_root = temp / "sources"
        source_root.mkdir()
        launchers = source_root / "generated-launchers"
        launchers.mkdir()
        shutil.copyfile(appdir / "AppRun", launchers / "AppRun")
        if (appdir / "apprun-hooks").is_dir():
            shutil.copytree(appdir / "apprun-hooks", launchers / "apprun-hooks")
        (stage / "linux-payload-inventory.json").write_text(json.dumps(records, indent=2) + "\n")
        if "--inventory-only" in sys.argv:
            print(json.dumps(sorted(packages.values(), key=lambda p: p["binary"]), indent=2))
            return
        def download(item):
            source, source_version = item
            directory = source_root / source
            directory.mkdir()
            result = subprocess.run(["apt-get", "source", "--download-only", "--only-source", f"{source}={source_version}"],
                                    cwd=directory, stdout=subprocess.DEVNULL)
            if result.returncode:
                # Runner images can contain superseded packages no longer indexed
                # by apt. Launchpad retains their exact original source uploads.
                query = urlencode({"ws.op": "getPublishedSources", "source_name": source,
                                   "version": source_version, "exact_match": "true"})
                publications = json.load(urlopen("https://api.launchpad.net/1.0/ubuntu/+archive/primary?" + query, timeout=60))
                if not publications["entries"]:
                    raise RuntimeError(f"Exact source upload unavailable: {source}={source_version}")
                publication = publications["entries"][0]["self_link"]
                urls = json.load(urlopen(publication + "?ws.op=sourceFileUrls", timeout=60))
                for url in urls:
                    name = unquote(Path(urlparse(url).path).name)
                    if Path(name).name != name:
                        raise RuntimeError("Invalid source filename")
                    with urlopen(url, timeout=180) as response, (directory / name).open("wb") as stream:
                        shutil.copyfileobj(response, stream)
            dsc = list(directory.glob("*.dsc"))
            if len(dsc) != 1:
                raise RuntimeError(f"Missing source descriptor for {source}")
            # dpkg-source checks the descriptor's archive checksums when unpacking.
            subprocess.run(["dpkg-source", "-x", dsc[0].name, "unpacked"], cwd=directory,
                           check=True, stdout=subprocess.DEVNULL)
            shutil.rmtree(directory / "unpacked")
        exact_sources = sorted({(p["source"], p["source_version"]) for p in packages.values()})
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(download, exact_sources))
        # Record/copy launcher and runtime source recursively at their actual revisions.
        runtime = output(str(image), "--appimage-version")
        revision = re.search(r"type2-runtime/commit/([a-f0-9]+)", runtime)
        if not revision:
            raise RuntimeError(f"Unknown AppImage runtime: {runtime}")
        # The source tag is valid only if its published launcher matches the payload.
        launcher = urlopen("https://github.com/AppImage/AppImageKit/releases/download/continuous/AppRun-x86_64", timeout=60).read()
        if hashlib.sha256(launcher).digest() != hashlib.sha256((appdir / "AppRun.wrapped").read_bytes()).digest():
            raise RuntimeError("AppRun is not the reviewed AppImageKit launcher")
        for repository, revision in (("type2-runtime", revision[1]), ("AppImageKit", "5735cc5bed206497cddfbd2a75e1982c2606c35d")):
            directory = source_root / repository
            subprocess.run(["git", "clone", "--quiet", f"https://github.com/AppImage/{repository}.git", str(directory)], check=True)
            subprocess.run(["git", "checkout", "--quiet", revision], cwd=directory, check=True)
            subprocess.run(["git", "submodule", "update", "--init", "--recursive", "--depth", "1"], cwd=directory, check=True)
            records.append({"component": repository, "revision": output("git", "rev-parse", "HEAD", cwd=directory)})
        runtime_dependencies = source_root / "runtime-dependencies"
        runtime_dependencies.mkdir()
        downloads = [
            ("fuse-3.15.0.tar.xz", "https://github.com/libfuse/libfuse/releases/download/fuse-3.15.0/fuse-3.15.0.tar.xz", "70589cfd5e1cff7ccd6ac91c86c01be340b227285c5e200baa284e401eea2ca0"),
            ("squashfuse-0.5.2.tar.gz", "https://github.com/vasi/squashfuse/archive/0.5.2.tar.gz", "db0238c5981dabbd80ee09ae15387f390091668ca060a7bc38047912491443d3"),
            ("musl-1.2.5.tar.gz", "https://musl.libc.org/releases/musl-1.2.5.tar.gz", None),
            ("zlib-1.3.1.tar.gz", "https://zlib.net/fossils/zlib-1.3.1.tar.gz", None),
            ("zstd-1.5.6.tar.gz", "https://github.com/facebook/zstd/archive/refs/tags/v1.5.6.tar.gz", None),
            ("mimalloc-2.1.7.tar.gz", "https://github.com/microsoft/mimalloc/archive/refs/tags/v2.1.7.tar.gz", None),
        ]
        dependency_notices = []
        for name, url, expected in downloads:
            data = urlopen(url, timeout=120).read()
            digest = hashlib.sha256(data).hexdigest()
            if expected and digest != expected:
                raise RuntimeError(f"Runtime dependency checksum mismatch: {name}")
            file = runtime_dependencies / name
            file.write_bytes(data)
            with tarfile.open(file) as tar:
                for member in tar.getmembers():
                    if member.isfile() and re.match(r"^(licen[cs]e|copying|notice|copyright)([._-]|$)", Path(member.name).name, re.I):
                        dependency_notices.extend([f"\n--- {name}: {member.name} ---", tar.extractfile(member).read().decode(errors="replace")])
            records.append({"runtime_dependency_source": name, "url": url, "sha256": digest,
                            "version_basis": "pinned runtime build recipe" if expected else "Alpine 3.21 permissive dependency reference source; see runtime Dockerfile"})
        notices = [f"Cosy FTP {version} — Linux AppImage system components",
                   f"Sources and build recipes: https://github.com/DrakonWolfDev/cosy-ftp/releases/tag/v{version}",
                   "See the linux-system-sources archive. Libraries are dynamically loaded and can be replaced by extracting the AppImage (--appimage-extract) and replacing its usr/lib files.",
                   "Modification and reverse engineering for debugging modifications to these libraries are permitted under their respective licences."]
        notices.extend(dependency_notices)
        for binary, package in sorted(packages.items()):
            copyright_file = Path("/usr/share/doc") / binary.split(":")[0] / "copyright"
            if not copyright_file.is_file():
                raise RuntimeError(f"Missing copyright for {binary}")
            notices.extend([f"\n{'=' * 72}\n{binary} {package['version']}\nSource: {package['source']} {package['source_version']}", copyright_file.read_text(errors="replace")])
        notices_dir = source_root / "notices"
        notices_dir.mkdir()
        for file in Path("/usr/share/common-licenses").iterdir():
            if file.is_file():
                shutil.copyfile(file, notices_dir / file.name)
                notices.extend([f"\n--- {file.name} ---", file.read_text(errors="replace")])
        for repository in ("AppImageKit", "type2-runtime"):
            for file in (source_root / repository).rglob("*"):
                if file.is_file() and re.match(r"^(licen[cs]e|copying|notice)([._-]|$)", file.name, re.I):
                    notices.extend([f"\n--- {file.relative_to(source_root)} ---", file.read_text(errors="replace")])
        text = "\n".join(notices) + "\n"
        (stage / "LINUX_SYSTEM_NOTICES.txt").write_text(text)
        (stage / "linux-payload-inventory.json").write_text(json.dumps(records, indent=2) + "\n")
        (source_root / "LINUX_SYSTEM_NOTICES.txt").write_text(text)
        (source_root / "linux-payload-inventory.json").write_text(json.dumps(records, indent=2) + "\n")
        with tarfile.open(stage / f"cosy-ftp-{version}-linux-system-sources.tar.gz", "w:gz") as archive:
            archive.add(source_root, arcname="linux-system-sources", filter=lambda info: None if "/.git/" in info.name or info.name.endswith("/.git") else info)
        print(f"Inventoried {len(records)} ELF files/components and archived {len(exact_sources)} exact system source packages")


if __name__ == "__main__":
    main()
