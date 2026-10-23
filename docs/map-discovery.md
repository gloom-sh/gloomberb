# Map series discovery

A failed map-series search reports that search is unavailable in the chart picker and series editor. It does not mean that the query has no matches. Other successful search results remain available.

CHOKE still recognizes the built-in strait names when its index is unavailable. Names that need the index report a lookup failure until it recovers. A successfully searched index with no matching chokepoint still lists the known names. Charts can continue to request a series directly when the index is down; failed reads report unavailable data instead of claiming that the series does not exist.
