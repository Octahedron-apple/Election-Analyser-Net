{ pkgs ? import <nixpkgs> {} }:
pkgs.mkShell {
  buildInputs = with pkgs; [
    nodejs_22
    # Core C/C++ (libc, libm, libdl, libpthread, librt, libstdc++, libgcc_s, libatomic)
    glibc stdenv.cc.cc.lib
    # Compression (libbrotli*, libz)
    brotli zlib
    # DNS (libcares)
    c-ares
    # TLS / Crypto (libssl, libcrypto)
    openssl
    # Unicode (libicu*)
    icu
    # HTTP/2 & HTTP/3 (libnghttp2, libnghttp3, libngtcp2)
    nghttp2 nghttp3 ngtcp2
    # UTF validation (libsimdutf)
    simdutf
    # Event loop (libuv)
    libuv
  ];
  LD_LIBRARY_PATH = with pkgs; lib.makeLibraryPath [
    glibc stdenv.cc.cc.lib brotli zlib c-ares openssl icu
    nghttp2 nghttp3 ngtcp2 simdutf libuv
  ];
}
