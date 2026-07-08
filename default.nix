{
  lib,
  buildNpmPackage,
  typescript,
  bun,
  tmux,
  guile,
  python3,
  nix,
  bash,
  R,
  mitscheme,
  jscpd,
  importNpmLock,
}:

buildNpmPackage (finalAttrs: {
  pname = "opencode-tmux-repl";
  version = (lib.importJSON ./package.json).version;
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./src
      ./test
      ./eslint.config.js
      ./knip.json
      ./.madgerc
      ./package.json
      ./package-lock.json
      ./tsconfig.json
    ];
  };

  npmDeps = importNpmLock {
    npmRoot = finalAttrs.src;
  };
  npmConfigHook = importNpmLock.npmConfigHook;

  nativeBuildInputs = [
    typescript
    bun
    tmux
    guile
    (python3.withPackages (ps: [ ps.ipython ]))
    nix
    bash
    R
    mitscheme
    jscpd
  ];
  buildPhase = ''
    runHook preBuild
    tsc -p tsconfig.json
    runHook postBuild
  '';

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    export PATH="$PWD/node_modules/.bin:$PATH"
    bun test
    eslint src/ test/
    knip
    jscpd src/ test/ --threshold 1
    madge --circular --extensions ts src/index.ts
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -r src package.json package-lock.json tsconfig.json $out/
    runHook postInstall
  '';

  meta = {
    description = "Shared tmux REPL tools for OpenCode";
    license = lib.licenses.mit;
  };
})
