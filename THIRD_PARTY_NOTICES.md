# Third-Party Notices

This repository is licensed under GPL-3.0 (see `LICENSE`).

## Included third-party code

**None.** All code currently distributed from this repository is first-party.

## Removed

### Ashima Arts / Stefan Gustavson simplex-noise implementation (MIT)

`assets/js/background-pattern.js` bundled a compact GLSL simplex-noise
implementation attributed in-source as "3D Simplex Noise (Ashima Arts — MIT
licence)". That file was removed in website release 0.27.0 along with the
animated WebGL background, so the repository no longer distributes this code and
the notice below no longer carries an obligation. It is retained for the audit
trail of releases up to and including 0.26.0.

Original upstream project references:
- https://github.com/ashima/webgl-noise
- https://github.com/stegu/webgl-noise

MIT License text:

```text
Copyright (C) 2011 by Ashima Arts (Simplex noise)
Copyright (C) 2011 by Stefan Gustavson (Classic noise)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
