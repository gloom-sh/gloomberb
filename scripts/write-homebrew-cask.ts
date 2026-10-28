import { dirname } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { DESKTOP_APP_IDENTIFIERS } from "../src/renderers/electrobun/shared/app-name";

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

  # No \`verified:\` here: Homebrew checks a GitHub release URL against the
  # homepage on its own now and warns that the parameter is deprecated (#916).
  url "https://github.com/gloom-sh/gloomberb/releases/download/v#{version}/stable-macos-arm64-Gloom.app.zip"
  name "Gloom"
  desc "Open-source finance terminal"
  homepage "https://gloom.sh"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true

  # The published app bundle is Apple Silicon only. Without this, Homebrew
  # installs an app on Intel Macs that dies with "Bad CPU type in executable".
  depends_on arch: :arm64

  # Gloomberb.app before the rename. An upgrade from such a version removes
  # it and installs this; the app leaves a Homebrew copy to Homebrew.
  app "Gloom.app"
  binary "#{appdir}/Gloom.app/Contents/Resources/gloom", target: "gloom"
  # The command's name before 0.18.4, kept for scripts and habits.
  binary "#{appdir}/Gloom.app/Contents/Resources/gloomberb", target: "gloomberb"

  # Quits the app under either of its bundle identifiers, whichever the
  # installed copy carries.
  uninstall quit: [${DESKTOP_APP_IDENTIFIERS.map((identifier) => JSON.stringify(identifier)).join(", ")}]

  zap trash: "~/.gloomberb"
end
`;
}

const options = readOptions();
mkdirSync(dirname(options.output), { recursive: true });
writeFileSync(options.output, renderCask(options));
