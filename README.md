# nicegui-p360

A [NiceGUI](https://nicegui.io) widget for interactive 360° image spin viewers,
built around a sprite-sheet or image-sequence workflow.

## Installation

```bash
# Widget only
pip install -e .

# Widget + processing pipeline (rembg, Pillow)
pip install -e ".[pipeline]"
```

## Processing pipeline

Convert a turntable video into a ready-to-serve sprite sheet:

```bash
p360-process mug.mp4
```

This runs the full pipeline:

1. Extract frames with `ffmpeg`
2. Remove background with `rembg`
3. Convert to WebP
4. Pack into a sprite sheet with ImageMagick `montage`

### Options

| Option | Default | Description |
| --- | --- | --- |
| `--skip N` | `2` | Keep every (N+1)th frame. 0=all, 1=every other, 2=every third, … |
| `--width N` | `800` | Scale each frame to this width (px) |
| `--webp-quality N` | `85` | WebP lossy quality (1–100) |
| `--rembg-model NAME` | `u2net` | rembg model (u2net, u2netp, isnet-general-use, …) |
| `--no-rembg` | off | Skip background removal |
| `--output-type` | `montage` | `montage` (sprite sheet) or `sequence` (individual files) |
| `--output-dir DIR` | `.` | Directory to write output into |
| `--output NAME` | `sprite.webp` | Output filename (montage) or template (sequence) |
| `--keep-frames` | off | Keep intermediate WebP frames alongside the sprite |
| `--dry-run` | off | Print commands without executing |

### Example: custom output directory

```bash
p360-process mug.mp4 --output-dir ./static/products/mug01 --skip 1
```

### External dependencies

The pipeline requires these tools to be installed separately:

- `ffmpeg` + `ffprobe`
- `rembg` — `pip install rembg[gpu]` (or `rembg[cpu]` for CPU)
- ImageMagick (`montage`) — via your system package manager

## Widget usage

```python
from nicegui import app, ui
from nicegui_p360 import Viewer360

app.add_static_files('/static', './static')

@ui.page('/')
def index():
    # Sprite mode (one HTTP request — recommended)
    Viewer360(
        sprite='/static/products/mug01/sprite.webp',
        frame_count=42,
        background='transparent',
        drag_sensitivity=8,
        auto_spin=0.5,   # rpm; 0 disables
    )

    # Sequence mode (individual frames)
    frames = [f'/static/products/mug01/frame_{i:03d}.webp' for i in range(1, 43)]
    Viewer360(frames=frames)

ui.run()
```

### Parameters

| Parameter | Default | Description |
| --- | --- | --- |
| `sprite` | `None` | URL of sprite sheet (sprite mode) |
| `frames` | `None` | List of frame URLs (sequence mode) |
| `frame_count` | `42` | Total number of frames |
| `cols` | auto | Sprite grid columns (auto-computed for square-ish layout) |
| `frame_width` | `800` | Frame width in sprite (px) |
| `frame_height` | `450` | Frame height in sprite (px) |
| `responsive_margin` | `0` | Pixels subtracted from measured parent/container width |
| `padding` | `1` | Inner spacing between viewport edge and rendered image |
| `sprite_boundary` | `False` | Draw a boundary around the rendered image area |
| `boundary_color` | `'#ff3b30'` | CSS color for the optional boundary |
| `boundary_width` | `1` | Boundary width in pixels |
| `background` | `'transparent'` | CSS background color |
| `drag_sensitivity` | `8` | Pixels of drag per frame step |
| `auto_spin` | `0.0` | Auto-spin speed in RPM (0 = disabled) |

### Sizing behavior

`Viewer360` always tracks the width of its parent container (for example, a `ui.card`).
No fixed-width mode is applied in the component.
