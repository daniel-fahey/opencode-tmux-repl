{
  description = "opencode-tmux-repl: shared tmux REPL tools for OpenCode";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    flake-parts.inputs.nixpkgs-lib.follows = "nixpkgs";
    jscpd.url = "github:kucherenko/jscpd/v5.0.11";
  };

  outputs =
    inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      perSystem =
        { config, pkgs, inputs', ... }:
        {
          packages.default = pkgs.callPackage ./default.nix {
            jscpd = inputs'.jscpd.packages.default;
          };

          checks.default = config.packages.default;

          devShells.default = pkgs.mkShell {
            packages = with pkgs; [
              bun
              tmux
              nodejs_latest
            ];
          };
        };
    };
}
