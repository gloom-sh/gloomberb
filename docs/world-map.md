# World map

`MAP` is one map for anything with a place: trading venues, country names, and layers for ships, ports, energy and airports, each with a table of what it holds.

| Type | Opens |
|---|---|
| `MAP` | The world map: trading venues and the default layers (today the shipping chokepoints) |
| `MAP venues` | Trading venues alone, with open status, local time and the next session change |
| `MAP ships` | Ships and shipping chokepoints |
| `MAP ports` | Ports with weekly calls and trade |
| `MAP energy` | Pipelines, oil and gas fields and LNG terminals, all in the United States (the terminals as of 31 Aug 2023); a search elsewhere says so |
| `MAP air` | Airports, and flights where they are switched on |

## Layers

Pick layers in the pane settings, grouped as ships, air, energy, ports and infrastructure, each with its cadence and status. Up to four layers show at once, two of them live. A layer added to Gloom Cloud appears in the picker without an app update. A plain `MAP` follows Gloom Cloud's default layers until you change its layers or venues; from then on it keeps what you chose.

The map's table lists one layer; the bar above it switches layers and `/` searches. `Enter` opens an entity: its figures, linked tickers, chart series and, for a ship, its recent track. `d` opens the linked company's description, `g` charts the entity's series.

Dense layers show counts until you zoom in. On the desktop and the web the map zooms until a pane shows some 15 km of sea, so a harbor or a strait fills it and ships stand apart. Zoom with the wheel, a trackpad pinch, a double click or `+` and `-` (`0` resets); drag to pan. From the keyboard, `m` hands the arrow keys to the map (Shift for bigger steps) and `Esc` gives them back to the list; clicking the map does the same. `<` and `>` narrow and widen the list beside the map. The map is drawn in Web Mercator, so a country keeps its shape at any latitude. Each layer has its own icon: a ship points along its course while under way and is a dot at rest, colored by class (hover **Ships** in the legend for the key); a view holding more than about 900 of one layer's points draws them as dots until you zoom closer. Hovering a feature shows its name. Coastlines sharpen as you zoom in: closer views switch to finer outlines and load only the part in view. Country names show on the desktop and the web, the largest on the world view and smaller ones as you zoom in; the terminal map leaves them out. Ticker links marked inferred are sector or ownership guesses; reviewed links name the owner or operator the source itself lists.

## Series in G

`GEO:<name>` charts a map series beside anything else, for example `G XOM, GEO:HORMUZ`. `CHOKE` opens the main chokepoints' daily transits, `CHOKE SUEZ` one of them. Transits are published some days after the ships pass, so a chart of map series alone ends at its newest observation rather than today, and the legend leads with that date (`Oct 4`); a series whose last value is older carries its own date. The chart editor's series search finds map series by name. `CORR FRO, STNG, GEO:HORMUZ` correlates a map series with tickers; see [research data](research-data.md#charts-comparisons-and-correlations) for how a count is paired with returns.

## From the shell

`gloomberb fn MAP --layer vessels --json` returns a layer's table with its linked tickers; `gloomberb shot MAP ships` saves a picture of the map.

## Map data

Land, coastlines, country borders and country names come from [Natural Earth](https://www.naturalearthdata.com/) (1:50m, and 1:10m when zoomed in; names and their label points from the 1:50m admin-0 countries), which is in the public domain; at the closest zooms the coastline is the 1:10m outline, drawn as straight runs a few hundred metres long. `bun run map:data` rebuilds them from a pinned release with `scripts/generate-world-map-data.ts`; the app ships the result and asks no outside host for map data.
