# Crayon to Car

Turn a coloured-in Tesla wrap template into a PNG for the car's Paint Shop.

1. Print a colouring sheet from the site (or Tesla's own template) and colour it in.
2. Photograph it and drop the photo on the page.
3. The template is found in the photo, lined up, cut out, and saved as a PNG that meets Tesla's limits (≤1024 px, under 1 MB).

Everything runs in the browser. Photos never leave the device.

## How the alignment works

- Thin, dark, colourless strokes (the printed outline) are picked out with a black-hat filter, so marker fills and coloured scribbles are ignored.
- A distance transform of those strokes is matched against the official template's outline. The sheet of paper seeds the search, which covers every car model and all four rotations.
- Levenberg–Marquardt then refines a full perspective homography to sub-pixel accuracy.
- The photo is warped into template space, the paper is levelled to white, the printed outlines are painted over, and everything outside the template's panels is made transparent.

The official templates load live from [teslamotors/custom-wraps](https://github.com/teslamotors/custom-wraps). To add a model, add a line to `models.js`.

## Develop

Static files with no build step. Serve the folder (`python3 -m http.server`) and open it. HEIC photos decode natively in Safari; other browsers load [heic-to](https://github.com/hoppergee/heic-to) from jsDelivr on demand.

Test: `node test/align.test.mjs`

Deploy: enable GitHub Pages from the `main` branch root.

Not affiliated with Tesla.
