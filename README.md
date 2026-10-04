# Chaos Draft

A static web app for Magic: The Gathering chaos drafts. Build a pool of packs, one per expansion, then pull them one at a time (without replacement) from a slot machine. Each pull shows a summary of the set.

## Features

- Search every paper expansion, core set, masters and draft-innovation set from Scryfall (tick "Include supplemental sets" for Un-sets, starters and more), or add N random sets.
- Slot-machine draw using `crypto.getRandomValues`; drawn packs are removed from the pool until you put them back.
- Set summary on each pull:
  - **Chase cards**: the rares and mythics with the highest Scryfall USD price.
  - **Bombs, top uncommons, top commons**: ranked by EDHREC popularity. Scryfall has no limited ratings, so this is a heuristic.
  - **Key mechanics** and **color spread** from the set's commons and uncommons.
- Pool and draws persist in `localStorage`; the Share button copies a link that loads the same pool.

## Run locally

No build step. Serve the folder with any static server:

```sh
python3 -m http.server 8000
```

## Deploy

`.github/workflows/pages.yml` publishes the site to GitHub Pages on every push to `main`. In the repository settings, set Pages → Source to "GitHub Actions" if it is not enabled automatically.

Card data and images © Scryfall / Wizards of the Coast. Not affiliated with Wizards of the Coast.
