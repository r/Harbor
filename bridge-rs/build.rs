use std::{env, path::PathBuf, process::Command};

fn main() {
    println!("cargo:rerun-if-changed=apple/AppleModel.swift");
    println!("cargo:rerun-if-env-changed=DEVELOPER_DIR");
    println!("cargo:rerun-if-env-changed=SDKROOT");
    if env::var("TARGET").as_deref() != Ok("aarch64-apple-darwin") {
        return;
    }

    // Native messaging launches the bridge by absolute path. Keep its optional
    // macOS companion beside it so no PATH lookup or user installation is needed.
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let helper = out.ancestors().nth(3).unwrap().join("harbor-apple-model");
    let version = Command::new("xcrun")
        .args(["--sdk", "macosx", "--show-sdk-version"])
        .output()
        .expect("xcrun is required to build the native macOS bridge");
    assert!(
        version.status.success(),
        "Could not determine the macOS SDK version"
    );
    let version = String::from_utf8_lossy(&version.stdout);
    let major: u32 = version
        .trim()
        .split('.')
        .next()
        .unwrap()
        .parse()
        .expect("macOS SDK major version");
    if major < 26 {
        if helper.exists() {
            std::fs::remove_file(&helper).expect("remove outdated Apple Intelligence companion");
        }
        println!("cargo:warning=Apple Intelligence requires the macOS 26 SDK or newer; building the bridge without it");
        return;
    }

    let status = Command::new("xcrun")
        .args([
            "--sdk",
            "macosx",
            "swiftc",
            "-O",
            "-parse-as-library",
            "-target",
            "arm64-apple-macos26.0",
            "apple/AppleModel.swift",
            "-o",
        ])
        .arg(helper)
        .status()
        .expect("start Swift compiler");
    assert!(
        status.success(),
        "Apple Intelligence companion build failed"
    );
}
