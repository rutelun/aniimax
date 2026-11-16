$ErrorActionPreference = 'Stop'
# Local benchmark build. Keep generated bindings outside the deployed assets.
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
    if (Test-Path 'target/qa-cargo-home') { $env:CARGO_HOME = Join-Path $root 'target/qa-cargo-home' }
    $env:CARGO_TARGET_DIR = Join-Path $root 'target/fast-build'
    $env:CARGO_PROFILE_RELEASE_OPT_LEVEL = '3'
    $env:RUSTC_BOOTSTRAP = '1'
    $sysroot = (& rustc +stable-x86_64-pc-windows-gnu --print sysroot).Trim()
    $linker = ($sysroot + '/lib/rustlib/x86_64-pc-windows-gnu/bin/rust-lld.exe').Replace('\','/')
    & cargo +stable-x86_64-pc-windows-gnu -Z host-config -Z target-applies-to-host --config "host.x86_64-pc-windows-gnu.linker=`"$linker`"" --config 'host.x86_64-pc-windows-gnu.rustflags=["-Z","unstable-options","-C","linker-flavor=gnu-lld","-C","link-self-contained=yes"]' build --lib --target wasm32-unknown-unknown --release --locked --offline
    if ($LASTEXITCODE -ne 0) { throw 'WASM compilation failed' }
    $bindgen = Join-Path $root 'target/wasm-bindgen-0.2.108-x86_64-pc-windows-msvc/wasm-bindgen.exe'
    if (!(Test-Path $bindgen)) { $bindgen = (Get-Command wasm-bindgen -ErrorAction Stop).Source }
    & $bindgen target/fast-build/wasm32-unknown-unknown/release/aniimax.wasm --target web --out-dir target/fast-wasm
    if ($LASTEXITCODE -ne 0) { throw 'WASM bindings generation failed' }
} finally { Pop-Location }
