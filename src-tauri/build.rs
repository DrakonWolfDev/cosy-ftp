use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};

fn collect(directory: &Path, files: &mut Vec<PathBuf>) {
    if !directory.exists() {
        return;
    }
    for entry in fs::read_dir(directory).expect("Read build inputs") {
        let entry = entry.expect("Read build input");
        if entry.file_type().expect("Read input type").is_dir() {
            collect(&entry.path(), files);
        } else if entry.file_type().expect("Read input type").is_file() {
            files.push(entry.path());
        }
    }
}
fn main() {
    tauri_build::build();
    let manifest = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let root = manifest.parent().unwrap();
    let mut files = Vec::new();
    for directory in ["src-tauri/src", "src", "shared", "dist"] {
        println!("cargo:rerun-if-changed={}", root.join(directory).display());
        collect(&root.join(directory), &mut files);
    }
    for file in [
        "src-tauri/build.rs",
        "src-tauri/Cargo.toml",
        "src-tauri/Cargo.lock",
        "src-tauri/tauri.conf.json",
        "src-tauri/tauri.windows.conf.json",
        "src-tauri/capabilities/main.json",
        "package.json",
        "package-lock.json",
        "index.html",
        "vite.config.ts",
    ] {
        println!("cargo:rerun-if-changed={}", root.join(file).display());
        files.push(root.join(file));
    }
    files.sort_by_key(|path| {
        path.strip_prefix(root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/")
    });
    let mut hash = Sha256::new();
    for file in files {
        hash.update(
            file.strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/")
                .as_bytes(),
        );
        hash.update([0]);
        hash.update(fs::read(file).expect("Read build input bytes"));
        hash.update([0]);
    }
    println!("cargo:rustc-env=COSY_BUILD_ID={:x}", hash.finalize());
}
