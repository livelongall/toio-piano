# toio x Piano (patched: sampler load guard)

Fixes:
- Waits for Tone.js sampler buffers to load before playing (avoids 'buffer is either not set or not loaded')
- Uses jsDelivr CDN for Salamander samples (avoids tonejs.github.io blocks)
- Falls back to a synth if samples can't load (network restriction / timeout)

Run:
- Use localhost or HTTPS
  python -m http.server 8000
  open http://localhost:8000
