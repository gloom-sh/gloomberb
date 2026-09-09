/**
 * Renders one representative layout in the terminal renderer under a list of
 * `<style>/<scheme>` pairs and prints each captured frame. This is the cheapest
 * way to see what a style actually does to the grid, since the difference is
 * structural: borders, header treatment, glyphs and density all show up in a
 * plain character frame.
 *
 *   bun run scripts/theme-style-shot.tsx terminal/amber phosphor/amber
 */
import { act } from "react";
import { PaneWrapper } from "../src/components/layout/pane";
import { Badge, Divider, KeyValueRow, Section } from "../src/components/ui";
import { testRender } from "../src/renderers/opentui/test-utils";
import { applyTheme } from "../src/theme/colors";
import { getSchemeIds } from "../src/theme/schemes";
import { getStyleIds } from "../src/theme/styles";
import { ThemeProvider } from "../src/theme/theme-context";
import { Box, Text } from "../src/ui";

const WIDTH = 62;
const HEIGHT = 18;

function Sample() {
  return (
    <Box flexDirection="column" width={WIDTH} height={HEIGHT}>
      <PaneWrapper title="Positions" focused width={WIDTH} height={11}>
        <Box flexDirection="column" paddingX={1}>
          <Section title="Holdings" width={WIDTH - 4}>
            <KeyValueRow label="AAPL" value="+2.41%" detail="184.20" width={WIDTH - 4} />
            <KeyValueRow label="MSFT" value="-0.62%" detail="412.55" width={WIDTH - 4} />
          </Section>
          <Divider width={WIDTH - 4} />
          <Box flexDirection="row" gap={1}>
            <Badge label="LIVE" tone="positive" />
            <Badge label="DELAYED" tone="warning" variant="solid" />
          </Box>
        </Box>
      </PaneWrapper>
      <PaneWrapper title="Watchlist" focused={false} width={WIDTH} height={7}>
        <Box flexDirection="column" paddingX={1}>
          <Text>NVDA   1,204.11   +3.8%</Text>
          <Text>TSLA     248.50   -1.2%</Text>
        </Box>
      </PaneWrapper>
    </Box>
  );
}

async function capture(styleId: string, schemeId: string): Promise<string> {
  applyTheme(schemeId, styleId);
  let renderer!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    renderer = await testRender(
      <ThemeProvider themeId={schemeId} styleId={styleId}>
        <Sample />
      </ThemeProvider>,
      { width: WIDTH, height: HEIGHT },
    );
  });
  await act(async () => {
    await renderer.renderOnce();
  });
  const frame = renderer.captureCharFrame();
  renderer.renderer.destroy?.();
  return frame;
}

const requested = process.argv.slice(2);
const pairs = (requested.length > 0 ? requested : ["terminal/amber", "phosphor/amber", "modern/catppuccin", "paper/paper", "minimal/rosepine"])
  .map((entry) => {
    const [styleId, schemeId] = entry.split("/");
    if (!styleId || !schemeId) throw new Error(`Expected <style>/<scheme>, got "${entry}"`);
    if (!getStyleIds().includes(styleId)) throw new Error(`Unknown style "${styleId}"`);
    if (!getSchemeIds().includes(schemeId)) throw new Error(`Unknown scheme "${schemeId}"`);
    return { styleId, schemeId };
  });

for (const { styleId, schemeId } of pairs) {
  const frame = await capture(styleId, schemeId);
  console.log(`\n### ${styleId} / ${schemeId}\n`);
  console.log(frame.split("\n").map((line) => line.replace(/\s+$/, "")).join("\n"));
}
process.exit(0);
