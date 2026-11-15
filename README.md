# Listen to Earth — The Earth Information Jukebox

NASA Space Apps Challenge 2026 · Challenge: *The Earth Information Jukebox*.

Live site: https://tanxichu.github.io/earth-information-jukebox/

NASA Earth Information Center (EIC) visualizations, made by the NASA Scientific Visualization Studio (SVS), are turned
into sound in the browser, so blind and low-vision people can explore them and anyone can hear the planet change.

* **NASA EIC animations → live piano.** 17 SVS animations, read live from the playing video (192×96 pixels every 2 s).
  *Sweep* mode cuts each frame into 8 strips west→east: one note per strip, more of the feature = higher, louder note;
  none = silence. *Whole frame* mode lets the frame's share of the feature decide how many notes of a public-domain
  Debussy piece play. The feature is chosen per animation from what its colours mean (ice = white, fires and heat = warm,
  vegetation and rain = green, smoke and CO = deep red); logos, dates and colour legends are masked out.
  Any SVS video can be dropped in and is analysed the same way.
* 30-second demo video: `demo/demo.mp4`.
* **Touch the map.** Point at the sea-ice map (mouse, touch or arrow keys): ice = high note, open water = low note,
  land = silence; `S` sweeps the row.
* **Guided listen** of September Arctic sea ice 1979–2026 with narration, A/B years, two measurements in one year.
* Screen-reader text, keyboard control, vibration cues, English / Chinese.

## Run locally
Any static web server, e.g. `python3 -m http.server` in this folder, then open `/product/`.

## Tests
Headless-browser checks (Playwright) live in the development repo: page errors, every control, sweep notes per animation, no horizontal scrolling at 320/375 px.

## Sources and licences
* Visualizations: NASA Scientific Visualization Studio, public domain (SVS IDs are listed on the page next to each animation).
* Data: NSIDC Sea Ice Index v4.0 (G02135); NASA GISS GISTEMP v4; NOAA GML Mauna Loa CO₂ annual mean.
  Sea-ice map images: NSIDC Sea Ice Index.
* Music: Claude Debussy (public domain); MIDI files from the Mutopia Project.
* Piano samples: Salamander Grand Piano V3 by Alexander Holm, CC-BY 3.0.
* Libraries: Tone.js 14.8.49 (MIT), @tonejs/midi 2.0.28 (MIT).
* Narration: synthetic voice generated with VoxCPM2 (Apache-2.0) from a text description; no real person's voice.

## AI use
The code, text and narration were made with AI assistance (Claude by Anthropic; VoxCPM2 for the voice).
Part of the prototype was built before the hackathon weekend.

## Licence
Our code: MIT (see LICENSE). Third-party assets keep their own licences listed above.
