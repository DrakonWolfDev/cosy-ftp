"""Native Tauri/WebDriver smoke test. Run under xvfb-run on headless Linux.

Requires tauri-driver, WebKitWebDriver (Linux) or msedgedriver (Windows), and a
application built with the production frontend embedded. No mock backend.
"""
import base64
import json
import hashlib
import ssl
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = Path(os.environ.get("COSY_SMOKE_ARTIFACTS", str(ROOT / ".test-artifacts" / "tauri")))
ARTIFACTS.mkdir(parents=True, exist_ok=True)
APPLICATION = Path(sys.argv[1]).resolve()
EXPECTED_VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
build_inputs = []
for directory in ("src-tauri/src", "src", "shared", "dist"):
    build_inputs += [file for file in (ROOT / directory).rglob("*") if file.is_file()]
build_inputs += [ROOT / file for file in ("src-tauri/build.rs", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/tauri.conf.json", "src-tauri/tauri.windows.conf.json", "src-tauri/capabilities/main.json", "package.json", "package-lock.json", "index.html", "vite.config.ts")]
build_hash = hashlib.sha256()
for file in sorted(build_inputs, key=lambda path: path.relative_to(ROOT).as_posix()):
    build_hash.update(file.relative_to(ROOT).as_posix().encode())
    build_hash.update(b"\0")
    build_hash.update(file.read_bytes())
    build_hash.update(b"\0")
EXPECTED_BUILD_ID = build_hash.hexdigest()
DRIVER = os.environ.get("COSY_TAURI_DRIVER", "tauri-driver")
BASE = "http://127.0.0.1:4444"


def request(method, route, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    with urlopen(Request(BASE + route, data=data, method=method,
                         headers={"Content-Type": "application/json"}), timeout=45) as response:
        result = json.load(response)
    value = result.get("value")
    if isinstance(value, dict) and value.get("error") and "ok" not in value:
        raise AssertionError(value)
    return value


with tempfile.TemporaryDirectory(prefix="cosy-tauri-smoke-") as directory:
    fixture = Path(directory)
    source, target = fixture / "source", fixture / "target"
    source.mkdir()
    target.mkdir()
    (source / "notes.txt").write_text("original\n", encoding="utf-8")
    (source / "binary.bin").write_bytes(bytes(range(256)) * 4096)
    remote_root = fixture / "remote"
    remote_root.mkdir()
    (remote_root / "remote.txt").write_text("remote original\n", encoding="utf-8")
    server = subprocess.Popen([os.environ.get("COSY_PYTHON", sys.executable), str(ROOT / "tests/fixtures/paramiko-server.py"), str(remote_root)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    server_info = json.loads(server.stdout.readline())
    ftps_root = fixture / "ftps"
    ftps_root.mkdir()
    (ftps_root / "ftps.txt").write_text("FTPS original\n", encoding="utf-8")
    ftps_server = subprocess.Popen([os.environ.get("COSY_PYTHON", sys.executable), str(ROOT / "tests/fixtures/ftp-server.py"), str(ftps_root), "tls", "13"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    ftps_info = json.loads(ftps_server.stdout.readline())
    ftps_der = ssl.PEM_cert_to_DER_cert(Path(ftps_info["certificate"]).read_text())
    ftps_fingerprint = ":".join(f"{byte:02X}" for byte in hashlib.sha256(ftps_der).digest())
    user_data = fixture / "userdata"
    user_data.mkdir()
    remote_profile = {"id": "sftp-fixture", "name": "Loopback SFTP", "protocol": "sftp", "host": "127.0.0.1", "port": server_info["port"], "username": "tester", "initialPath": "/", "allowInsecure": False, "hasPassword": False}
    ftps_profile = dict(remote_profile, id="ftps-fixture", name="Loopback FTPS", protocol="ftps", port=ftps_info["port"])
    (user_data / "connections.json").write_text(json.dumps({"version": 1, "profiles": [remote_profile, ftps_profile], "hosts": {f"127.0.0.1:{server_info['port']}": server_info["fingerprint"]}, "ftpsHosts": {f"127.0.0.1:{ftps_info['port']}": ftps_fingerprint}}), encoding="utf-8")
    environment = dict(os.environ, COSY_USER_DATA=str(fixture / "userdata"))
    with (ARTIFACTS / "driver.log").open("w") as log:
        driver_arguments = [DRIVER]
        if os.environ.get("COSY_NATIVE_DRIVER"):
            driver_arguments += ["--native-driver", os.environ["COSY_NATIVE_DRIVER"]]
        driver = subprocess.Popen(driver_arguments, env=environment, stdout=log, stderr=log)
        session = None
        try:
            for _ in range(100):
                try:
                    request("GET", "/status")
                    break
                except OSError:
                    time.sleep(0.1)
            value = request("POST", "/session", {"capabilities": {"alwaysMatch": {
                "tauri:options": {"application": str(APPLICATION)}
            }}})
            session = value["sessionId"]
            prefix = f"/session/{session}"

            def js(script, args=None, asynchronous=False):
                return request("POST", prefix + "/execute/" + ("async" if asynchronous else "sync"),
                               {"script": script, "args": args or []})

            def api(name, value=None, expect_ok=True):
                result = js("const done=arguments[arguments.length-1]; window.cosy[arguments[0]](arguments[1]).then(done).catch(e=>done({ok:false,error:String(e)}));",
                            [name, value], True)
                if expect_ok:
                    assert result["ok"], result
                    return result.get("value")
                assert not result["ok"], result
                return result

            for _ in range(100):
                if js("return !!window.cosy && !!document.querySelector('.app-shell');"):
                    break
                time.sleep(0.1)
            else:
                raise AssertionError(js("return document.body.innerText"))

            initial = api("initialise")
            assert initial["version"] == EXPECTED_VERSION, initial
            assert initial["buildId"] == EXPECTED_BUILD_ID, "Desktop executable does not match the current source/assets; finish rebuilding before running checks."
            assert initial["sessions"][0]["id"] == "local"
            assert js("return document.querySelector('.queue-toggle').getAttribute('aria-expanded')") == "true"

            listing = api("list", {"sessionId": "local", "path": str(source)})
            assert {item["name"] for item in listing["entries"]} == {"notes.txt", "binary.bin"}
            api("mkdir", {"location": {"sessionId": "local", "path": str(target)}, "name": "folder"})
            api("rename", {"location": {"sessionId": "local", "path": str(target)}, "name": "folder", "newName": "renamed"})
            api("mkdir", {"location": {"sessionId": "local", "path": str(target)}, "name": "../escape"}, False)
            job = api("enqueue", {"source": {"sessionId": "local", "path": str(source)},
                                  "destination": {"sessionId": "local", "path": str(target)},
                                  "names": ["binary.bin"], "overwrite": False, "move": False})
            for _ in range(100):
                saved = next(item for item in api("initialise")["jobs"] if item["id"] == job["id"])
                if saved["state"] in ("failed", "completed", "cancelled"):
                    break
                time.sleep(0.1)
            assert saved["state"] == "completed", saved
            assert (target / "binary.bin").read_bytes() == (source / "binary.bin").read_bytes()
            doc = api("openEditor", {"sessionId": "local", "path": str(source / "notes.txt")})
            api("saveDraft", {"id": doc["id"], "content": "my draft\n"})
            (source / "notes.txt").write_text("changed elsewhere\n", encoding="utf-8")
            api("uploadEdit", doc["id"], False)
            comparison = api("compareEdit", doc["id"])
            assert comparison["changed"]
            (source / "notes.txt").write_text("changed again\n", encoding="utf-8")
            api("reviewEdit", {"id": doc["id"], "revision": comparison["revision"]}, False)
            comparison = api("compareEdit", doc["id"])
            api("reviewEdit", {"id": doc["id"], "revision": comparison["revision"]})
            assert (source / "notes.txt").read_text() == "changed again\n"
            api("uploadEdit", doc["id"])
            assert (source / "notes.txt").read_text() == "my draft\n"
            api("closeEdit", doc["id"])
            profile = api("saveProfile", {"name": "Session only", "protocol": "sftp", "host": "127.0.0.1", "port": 22,
                                          "username": "tester", "initialPath": "/", "rememberPassword": False, "allowInsecure": False})
            assert not profile["hasPassword"]
            api("deleteProfile", profile["id"])
            remote_session = api("connect", {"profileId": "sftp-fixture", "password": "test-password"})
            remote_listing = api("list", {"sessionId": remote_session["id"], "path": "/"})
            assert remote_listing["remote"] and any(item["name"] == "remote.txt" for item in remote_listing["entries"])
            api("forgetHost", f"127.0.0.1:{server_info['port']}", False)
            remote_document = api("openEditor", {"sessionId": remote_session["id"], "path": "/remote.txt"})
            api("saveDraft", {"id": remote_document["id"], "content": "saved through Rust SFTP\n"})
            api("uploadEdit", remote_document["id"])
            assert (remote_root / "remote.txt").read_text() == "saved through Rust SFTP\n"
            assert api("reconnect", remote_session["id"])["id"] == remote_session["id"]
            api("closeEdit", remote_document["id"])
            api("disconnect", remote_session["id"])
            ftps_session = api("connect", {"profileId": "ftps-fixture", "password": "test-password"})
            saved_certificates = api("trustedCertificates")
            assert any(item["fingerprint"] == ftps_fingerprint and item["connected"] for item in saved_certificates)
            api("forgetCertificate", f"127.0.0.1:{ftps_info['port']}", False)
            ftps_document = api("openEditor", {"sessionId": ftps_session["id"], "path": "/ftps.txt"})
            api("saveDraft", {"id": ftps_document["id"], "content": "Saved over pinned FTPS\n"})
            if os.name == "nt":
                # pyftpdlib uses os.rename: Windows refuses replacing an existing file.
                refused = api("uploadEdit", ftps_document["id"], False)
                assert "550" in refused["error"], refused
                assert (ftps_root / "ftps.txt").read_text() == "FTPS original\n"
                restored = api("saveDraft", {"id": ftps_document["id"], "content": ftps_document["content"]})
                assert not restored["dirty"], restored
            else:
                api("uploadEdit", ftps_document["id"])
                assert (ftps_root / "ftps.txt").read_text() == "Saved over pinned FTPS\n"
            api("closeEdit", ftps_document["id"])
            ftps_job = api("enqueue", {"source": {"sessionId": "local", "path": str(source)},
                                      "destination": {"sessionId": ftps_session["id"], "path": "/"},
                                      "names": ["binary.bin"], "overwrite": False, "move": False})
            for _ in range(100):
                ftps_jobs = api("initialise")["jobs"]
                completed = next(item for item in ftps_jobs if item["id"] == ftps_job["id"])
                if completed["state"] in ("completed", "failed", "cancelled"):
                    break
                time.sleep(0.1)
            assert completed["state"] == "completed", completed
            assert (ftps_root / "binary.bin").read_bytes() == (source / "binary.bin").read_bytes()
            api("disconnect", ftps_session["id"])
            assert "test-password" not in (user_data / "connections.json").read_text()
            if initial["canStorePasswords"]:
                remembered_input = {key: value for key, value in remote_profile.items() if key not in ("id", "hasPassword")}
                remembered_input.update(name="Remembered loopback", password="test-password", rememberPassword=True)
                remembered = api("saveProfile", remembered_input)
                assert remembered["hasPassword"]
                def reload_profiles():
                    js("location.reload();")
                    for _ in range(100):
                        if js("return !!window.cosy && Array.from(document.querySelectorAll('.saved-connections .place')).some(el=>el.textContent.includes('Remembered loopback'));"):
                            return
                        time.sleep(0.1)
                    raise AssertionError("Remembered profile did not appear after restart")

                def wait_for_connection(side):
                    for _ in range(100):
                        if js("return !document.querySelector('[role=dialog]') && document.querySelector('[aria-label=\"" + side + " connection\"]').selectedOptions[0].textContent.includes('Remembered loopback');"):
                            return
                        time.sleep(0.1)
                    raise AssertionError(js("return document.body.innerText"))

                reload_profiles()
                js("Array.from(document.querySelectorAll('.saved-connections .place')).find(el=>el.textContent.includes('Remembered loopback')).click();")
                wait_for_connection("right")
                assert js("return document.querySelector('[aria-label=\"left connection\"]').value") == "local"
                assert not js("return !!document.querySelector('input[type=password]')")
                # Explicit pane selection still overrides the sidebar's right-pane default.
                js("const el=document.querySelector('[aria-label=\"left connection\"]'); el.value='connect:'+arguments[0]; el.dispatchEvent(new Event('change',{bubbles:true}));", [remembered["id"]])
                wait_for_connection("left")
                for opened in api("initialise")["sessions"]:
                    if opened.get("profileId") == remembered["id"]:
                        api("disconnect", opened["id"])
                # A rejected stored credential falls back to a usable prompt.
                api("saveProfile", dict(remembered_input, id=remembered["id"], password="wrong-fixture-password"))
                reload_profiles()
                js("Array.from(document.querySelectorAll('.saved-connections .place')).find(el=>el.textContent.includes('Remembered loopback')).click();")
                for _ in range(100):
                    if js("return !!document.querySelector('input[type=password]:not(:disabled)') && !!document.querySelector('[role=alert]');"):
                        break
                    time.sleep(0.1)
                else:
                    raise AssertionError("Rejected saved password did not offer an override")
                js("const el=document.querySelector('input[type=password]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'test-password'); el.dispatchEvent(new Event('input',{bubbles:true}));")
                js("document.querySelector('input[type=password]').form.requestSubmit();")
                wait_for_connection("right")
                for opened in api("initialise")["sessions"]:
                    if opened.get("profileId") == remembered["id"]:
                        api("disconnect", opened["id"])
                api("deleteProfile", remembered["id"])
                assert "test-password" not in (user_data / "connections.json").read_text()
                assert "wrong-fixture-password" not in (user_data / "connections.json").read_text()
                js("location.reload();")
                time.sleep(0.3)

            # Exercise the visible Edit action with JSON larger than the former 2 MiB limit.
            large_json = json.dumps({"enabled": True, "items": ["x" * 80] * 40000}, indent=2) + "\n"
            json_file = source / "settings.json"
            json_file.write_bytes(large_json.encode())
            (source / "other.txt").write_bytes(b"another working copy\n")
            # Drive the actual path input so the screenshot shows fixture data.
            js("const el=document.querySelector('[aria-label=\"left path\"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,arguments[0]); el.dispatchEvent(new Event('input',{bubbles:true}));", [str(source)])
            element = request("POST", prefix + "/element", {"using": "css selector", "value": '[aria-label="left path"]'})
            element_id = element["element-6066-11e4-a52e-4f735466cecf"]
            request("POST", prefix + f"/element/{element_id}/value", {"text": "\ue007"})
            time.sleep(0.3)

            def wait_ui(script):
                for _ in range(200):
                    if js(script):
                        return
                    time.sleep(0.1)
                raise AssertionError(js("return document.body.innerText.slice(-5000)"))

            def edit_file(name):
                js("document.querySelectorAll('.file-pane')[0].querySelectorAll('tbody input:checked').forEach(el=>el.click());")
                js("Array.from(document.querySelectorAll('.file-pane')[0].querySelectorAll('tbody input')).find(el=>el.getAttribute('aria-label')==='Select '+arguments[0]).click();", [name])
                js("document.querySelector('[aria-label=\"left edit selected file\"]').click();")
                wait_ui("return !!document.querySelector('[aria-label=\"Text editor\"] textarea');")

            edit_file("settings.json")
            assert js("return document.querySelector('[aria-label=\"Text editor\"] textarea').value.length") > 2 * 1024 * 1024
            edited_json = large_json.replace('"enabled": true', '"enabled": false', 1)
            js("const el=document.querySelector('[aria-label=\"Text editor\"] textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,arguments[0]); el.dispatchEvent(new Event('input',{bubbles:true}));", [edited_json])
            wait_ui("return document.querySelector('.editor-status').textContent.includes('Working copy saved locally');")
            js("Array.from(document.querySelectorAll('.editor-actions button')).find(el=>el.textContent.includes('Save to disk')).click();")
            wait_ui("return document.querySelector('.editor-status').textContent.includes('Saved to disk');")
            assert json_file.read_bytes() == edited_json.encode()
            js("document.querySelector('[aria-label=\"Hide editor (keep working copies)\"]').click();")
            assert not js("return !!document.querySelector('[aria-label=\"Text editor\"]');")
            assert any(doc["name"] == "settings.json" for doc in api("initialise")["documents"])
            edit_file("other.txt")
            # Closing a background tab must not hide the editor or change the active tab.
            js("document.querySelector('[aria-label=\"Close settings.json\"]').click();")
            wait_ui("return !!document.querySelector('[aria-label=\"Text editor\"]') && document.querySelectorAll('.editor-tab').length===1;")
            assert js("return document.querySelector('.editor-tab.selected').textContent") == "other.txt"
            js("document.querySelector('[aria-label=\"Hide editor (keep working copies)\"]').click();")
            edit_file("settings.json")
            # Closing the active tab selects its neighbour; only the last tab closes the window.
            js("document.querySelector('[aria-label=\"Close settings.json\"]').click();")
            wait_ui("return !!document.querySelector('[aria-label=\"Text editor\"]') && document.querySelectorAll('.editor-tab').length===1;")
            assert js("return document.querySelector('.editor-tab.selected').textContent") == "other.txt"
            js("document.querySelector('[aria-label=\"Close other.txt\"]').click();")
            wait_ui("return !document.querySelector('[aria-label=\"Text editor\"]');")
            assert not api("initialise")["documents"]
            # A long remote listing must retain its viewport through refreshes and mutations.
            for index in range(400):
                (remote_root / f"scroll-{index:04}.txt").write_bytes(b"remote text\n")
            (remote_root / "child").mkdir()
            js("Array.from(document.querySelectorAll('.saved-connections .place')).find(el=>el.textContent.includes('Loopback SFTP')).click();")
            wait_ui("return !!document.querySelector('input[type=password]');")
            js("const el=document.querySelector('input[type=password]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'test-password'); el.dispatchEvent(new Event('input',{bubbles:true}));")
            js("document.querySelector('input[type=password]').form.requestSubmit();")
            wait_ui("return !document.querySelector('[role=dialog]') && document.querySelector('[aria-label=\"right connection\"]').value!=='local' && !document.querySelector('[aria-label=\"right refresh\"]').disabled;")
            js("document.querySelector('[aria-label=\"right files\"]').scrollTop=4500;")
            time.sleep(0.15)
            previous_scroll = js("return document.querySelector('[aria-label=\"right files\"]').scrollTop;")
            assert previous_scroll > 4000

            def assert_remote_scroll():
                wait_ui("return !document.querySelector('[role=dialog]') && !document.querySelector('[aria-label=\"right refresh\"]').disabled;")
                actual = js("return document.querySelector('[aria-label=\"right files\"]').scrollTop;")
                assert abs(actual - previous_scroll) <= 35, (previous_scroll, actual)

            js("document.querySelector('[aria-label=\"right refresh\"]').click();")
            assert_remote_scroll()
            js("Array.from(document.querySelectorAll('.file-pane')[1].querySelectorAll('.pane-actions button')).find(el=>el.textContent.includes('New folder')).click();")
            js("const el=document.querySelector('[role=dialog] input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'created-while-scrolled'); el.dispatchEvent(new Event('input',{bubbles:true}));")
            js("document.querySelector('[role=dialog] form').requestSubmit();")
            assert_remote_scroll()
            assert (remote_root / "created-while-scrolled").is_dir()
            previous_scroll = js("return document.querySelector('[aria-label=\"right files\"]').scrollTop;")
            visible_file = js("const pane=document.querySelector('[aria-label=\"right files\"]'); const row=Array.from(pane.querySelectorAll('tbody tr')).find(row=>row.querySelector('.file-name') && row.getBoundingClientRect().top>pane.getBoundingClientRect().top+40); row.querySelector('.file-name').click(); return row.querySelector('.file-name').textContent;")
            js("document.querySelectorAll('.file-pane')[1].querySelector('[title=\"Rename selected item\"]').click();")
            js("const el=document.querySelector('[role=dialog] input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'renamed-'+arguments[0]); el.dispatchEvent(new Event('input',{bubbles:true}));", [visible_file])
            js("document.querySelector('[role=dialog] form').requestSubmit();")
            assert_remote_scroll()
            assert (remote_root / ("renamed-" + visible_file)).exists()
            previous_scroll = js("return document.querySelector('[aria-label=\"right files\"]').scrollTop;")
            js("const pane=document.querySelector('[aria-label=\"right files\"]'); const row=Array.from(pane.querySelectorAll('tbody tr')).find(row=>row.querySelector('.file-name') && row.getBoundingClientRect().top>pane.getBoundingClientRect().top+40); row.querySelector('.file-name').click();")
            js("document.querySelector('[aria-label=\"right edit selected file\"]').click();")
            wait_ui("return !!document.querySelector('[aria-label=\"Text editor\"] textarea');")
            js("const el=document.querySelector('[aria-label=\"Text editor\"] textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,arguments[0]); el.dispatchEvent(new Event('input',{bubbles:true}));", ["saved without losing position\n"])
            wait_ui("return document.querySelector('.editor-status').textContent.includes('Working copy saved locally');")
            js("Array.from(document.querySelectorAll('.editor-actions button')).find(el=>el.textContent.includes('Save to server')).click();")
            wait_ui("return document.querySelector('.editor-status').textContent.includes('Saved to server');")
            js("document.querySelector('.editor-tab .icon-button').click();")
            assert_remote_scroll()
            js("const el=document.querySelector('[aria-label=\"right path\"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'/child'); el.dispatchEvent(new Event('input',{bubbles:true}));")
            js("document.querySelector('[aria-label=\"right path\"]').form.requestSubmit();")
            wait_ui("return document.querySelector('[aria-label=\"right path\"]').value==='/child' && !document.querySelector('[aria-label=\"right refresh\"]').disabled;")
            assert js("return document.querySelector('[aria-label=\"right files\"]').scrollTop;") == 0
            accessibility = {}
            for theme in ("dark", "light"):
                if js("return document.documentElement.dataset.theme") != theme:
                    js("Array.from(document.querySelectorAll('.sidebar button')).find(el=>el.textContent.includes('theme')).click()")
                time.sleep(0.25)
                assert js("return document.documentElement.dataset.theme") == theme
                js((ROOT / "node_modules/axe-core/axe.min.js").read_text(encoding="utf-8"))
                violations = js("const done=arguments[arguments.length-1]; axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa']}}).then(r=>done(r.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}))))", asynchronous=True)
                accessibility[theme] = violations
                assert not violations, json.dumps(violations, indent=2)
                image = request("GET", prefix + "/screenshot")
                (ARTIFACTS / f"{theme}.png").write_bytes(base64.b64decode(image))

            request("POST", prefix + "/window/rect", {"width": 980, "height": 680})
            time.sleep(0.25)
            (ARTIFACTS / "compact.png").write_bytes(base64.b64decode(request("GET", prefix + "/screenshot")))
            report = {"version": initial["version"], "buildId": initial["buildId"], "canStorePasswords": initial["canStorePasswords"], "accessibility": accessibility, "checks": ["native startup", "expanded queue default", "local browse/mkdir/rename", "unsafe path rejection",
                      "queued binary transfer", "draft recovery", "visible Edit action opens and saves JSON above 2 MiB", "hide editor retains working copies", "closing active/background editor tabs preserves remaining tabs", "conflict refusal", "stale review refusal", "review without save", "explicit save",
                      "session-only profiles", "pinned SFTP connection", "connected trust removal refusal", "remote editor save", "session-preserving reconnect", "pinned self-signed FTPS reads and queued uploads with required TLS 1.3 session resumption", "connected FTPS trust removal refusal", "new palette and logo screenshots", "remote scroll retained after refresh, mkdir, rename and editor save", "new directory starts at top"]}
            if initial["canStorePasswords"]:
                report["checks"].extend(["OS credential save/retrieve/delete without plaintext storage", "saved-password sidebar connection without a password prompt", "right-pane default and explicit left-pane override", "rejected saved-password recovery with session-only override"])
            (ARTIFACTS / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
            print(json.dumps(report, indent=2))
        finally:
            if session:
                try:
                    request("DELETE", f"/session/{session}")
                except OSError:
                    pass
            driver.terminate()
            driver.wait(timeout=10)
            server.terminate()
            server.wait(timeout=10)
            ftps_server.terminate()
            ftps_server.wait(timeout=10)
