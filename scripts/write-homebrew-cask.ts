import { dirname } from "path";
import { mkdirSync, writeFileSync } from "fs";

interface Options {
  version: string;
  sha256: string;
  output: string;
}

function readOptions(): Options {
  const args = process.argv.slice(2);
  const options: Partial<Options> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = args[i + 1];
    if (!value) {
      throw new Error(`Missing value for ${arg}`);
    }
    switch (arg) {
      case "--version":
        options.version = value;
        i++;
        break;
      case "--sha256":
        options.sha256 = value;
        i++;
        break;
      case "--output":
        options.output = value;
        i++;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.version || !/^\d+\.\d+\.\d+$/.test(options.version)) {
    throw new Error("--version must be in X.Y.Z format");
  }
  if (!options.sha256 || !/^[a-f0-9]{64}$/.test(options.sha256)) {
    throw new Error("--sha256 must be a lowercase SHA-256 digest");
  }
  if (!options.output) {
    throw new Error("--output is required");
  }

  return options as Options;
}

function renderCask({ version, sha256 }: Pick<Options, "version" | "sha256">): string {
  return `cask "gloomberb" do
  version "${version}"
  sha256 "${sha256}"

  url "https://github.com/gloom-sh/gloomberb/releases/download/v#{version}/stable-macos-arm64-Gloomberb.app.zip",
      verified: "github.com/gloom-sh/gloomberb/"
  name "Gloomberb"
  desc "Open-source finance terminal"
  homepage "https://gloomberb.com"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true

  app "Gloomberb.app"
  binary "#{appdir}/Gloomberb.app/Contents/Resources/gloomberb", target: "gloomberb"

  uninstall quit: "com.vincelwt.gloomberb"

  zap trash: "~/.gloomberb"
end
`;
}

const options = readOptions();
mkdirSync(dirname(options.output), { recursive: true });
writeFileSync(options.output, renderCask(options));
