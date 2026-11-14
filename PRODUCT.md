# Wrap Drawings

Inferred from the owner's brief; they asked for decisions to be made on their behalf.

## Users and job

A parent with a Tesla and children who colour in printed wrap templates with crayons, pencils and markers. The parent photographs the finished drawing on a phone and wants a PNG the car's Paint Shop accepts, with no editing skills or software needed. Children are present and watching; the result is a moment of delight.

## What it does

- Takes a phone photo (JPEG, HEIC, PNG) of a printed, coloured-in Tesla wrap template.
- Finds the template in the photo automatically, corrects perspective and rotation, and registers it precisely to Tesla's official template.
- Removes everything that will not appear on the car (areas transparent in the template) and the printed outline strokes.
- Exports a PNG within Tesla's limits: 512–1024 px, under 1 MB, filename of letters, numbers, spaces, dashes and underscores, max 30 characters.
- Generates printable colouring sheets that hatch out the parts that never show on the car (glass roof, gaps), with registration marks.

## Constraints

- Static site on GitHub Pages. Everything runs in the browser; photos never leave the device.
- Generic across all vehicles in github.com/teslamotors/custom-wraps; the owner drives a Model Y.
- Registration accuracy is the primary quality bar.

## Platform

web

## Stack

Delegated: plain static HTML, CSS and ES modules, no build step.
