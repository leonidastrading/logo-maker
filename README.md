# Network Logo Maker

Static web app for generating "molecular network" logos: dots joined by connections, melted together with smooth fillets.

- Sliders for dot count, spread, spacing, neighbour connections, long links, dot size/variation, end-dot size, connection thickness and gooeyness
- Drag dots, double-click to add, right-click / Alt-click to delete
- Export PNG up to 12000 × 12000 (rendered in tiles) or a vector SVG
- Settings are kept in the URL hash, so a link reproduces the layout

No build step — deploy the folder as-is (Vercel framework preset: "Other").
