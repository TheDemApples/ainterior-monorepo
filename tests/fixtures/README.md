# tests/fixtures

The image fixtures used by `tests/test_vision.mjs` are **not tracked in git** — they are
binary PNG/JPEG files and were omitted when this repository was populated.

`tests/test_vision.mjs` reads them synchronously off disk from this directory:

```js
const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (f) => fs.readFileSync(path.join(FX, f));
```

Files the vision suite actually reads, and what each one proves:

| file | used for |
| --- | --- |
| `sofa_a.png` | the reference/catalog image — phash shape, 512-d L2-normalised embedding, self-cosine 1.0, phash distance 0 against itself |
| `sofa_a_variant.png` | same object shifted + brighter — must stay above `DEDUPE_THRESHOLD` (0.86) so the upload is gated and costs 0 credits |
| `sofa_a_rescaled.png` | resampled (downscale/upscale) copy — must also stay above 0.86 |
| `lamp.png` | a genuinely different piece — must fall below 0.86 so a credit is charged |
| `sofa_a.jpg` | JPEG DC-only decode path — `pHash` and `decodeToGray` must work on JPEG bytes |

`sofa_a_blur.png` and `sofa_a_gray.png` also exist in the original source tree but are not
referenced by `tests/test_vision.mjs` or any other test in `tests/`.

There is **no generator script** for these fixtures anywhere in the repository — they are
committed-by-hand binary assets, not build output. Restore them from the original source
archive before running `tests/test_vision.mjs`; without them the vision suite's
image-backed cases will fail on `ENOENT`.

Note: `packages/catalog/contact_sheet.png` was likewise omitted for being binary, but that
one *is* reproducible — `python3 tools/contact_sheet.py` regenerates it (see
`packages/catalog/CATALOG.md`).
