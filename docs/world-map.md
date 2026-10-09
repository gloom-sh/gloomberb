# World map

`MAP` is one map for anything with a place. Trading venues are its default layer; other layers add ships, ports, energy and airports to the same map, each with a table of what it holds.

| Type | Opens |
|---|---|
| `MAP` | Trading venues with open status, local time and the next session change |
| `MAP ships` | Ships and shipping chokepoints |
| `MAP ports` | Ports with weekly calls and trade |
| `MAP energy` | Pipelines, oil and gas fields and LNG terminals |
| `MAP air` | Airports, and flights where they are switched on |

## Layers

Pick layers in the pane settings, grouped as ships, air, energy, ports and infrastructure, each with its cadence and status. Up to four layers show at once, two of them live. A layer added to Gloom Cloud appears in the picker without an app update.

The map's table lists one layer; the bar above it switches layers and `/` searches. `Enter` opens an entity: its figures, linked tickers, chart series and, for a ship, its recent track. `d` opens the linked company's description, `g` charts the entity's series.

Dense layers show counts until you zoom in (wheel, `+`, `-`). Ticker links marked inferred are sector or ownership guesses; reviewed links name the owner or operator the source itself lists.

## Series in G

`GEO:<name>` charts a map series beside anything else, for example `G XOM, GEO:HORMUZ`. `CHOKE` opens the main chokepoints' daily transits, `CHOKE SUEZ` one of them. The chart editor's series search finds map series by name.

## From the shell

`gloomberb fn MAP --layer vessels --json` returns a layer's table with its linked tickers; `gloomberb shot MAP ships` saves a picture of the map.
