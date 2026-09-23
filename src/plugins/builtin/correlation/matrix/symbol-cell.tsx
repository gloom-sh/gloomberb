import { useCallback } from "react";
import { Box, Text, TextAttributes } from "../../../../ui";
import { colors, hoverBg } from "../../../../theme/colors";
import { displaySymbol } from "./model";

function handleSymbolMouseDown(event: {
  preventDefault?: () => void;
  stopPropagation?: () => void;
}, openSymbol: () => void): void {
  event.preventDefault?.();
  event.stopPropagation?.();
  openSymbol();
}

export function SymbolLabelCell({
  symbol,
  width,
  color,
  align = "flex-start",
  hovered,
  onHover,
  onLeave,
  onOpen,
}: {
  symbol: string;
  width: number;
  color: string;
  align?: "flex-start" | "flex-end";
  hovered: boolean;
  onHover: (symbol: string) => void;
  onLeave: (symbol: string) => void;
  onOpen: (symbol: string) => void;
}) {
  const openSymbol = useCallback(() => onOpen(symbol), [onOpen, symbol]);
  return (
    <Box
      width={width}
      flexShrink={0}
      flexDirection="row"
      justifyContent={align}
      paddingRight={align === "flex-end" ? 1 : undefined}
      overflow="hidden"
      backgroundColor={hovered ? hoverBg() : undefined}
      style={{ cursor: "pointer" }}
      onMouseOver={() => onHover(symbol)}
      onMouseOut={() => onLeave(symbol)}
      onMouseDown={(event: any) => handleSymbolMouseDown(event, openSymbol)}
    >
      <Text
        fg={hovered ? colors.textBright : color}
        attributes={TextAttributes.BOLD | TextAttributes.UNDERLINE}
      >
        {displaySymbol(symbol)}
      </Text>
    </Box>
  );
}
