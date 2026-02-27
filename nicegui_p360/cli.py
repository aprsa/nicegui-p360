"""
p360-process — Convert a turntable video into a 360° spin viewer asset.

Pipeline:
  1. Extract frames from video with ffmpeg
  2. Remove background with rembg
  3. Convert to WebP
  4. Pack into a sprite sheet with ImageMagick montage  (--output-type montage)
     OR keep as an image sequence                       (--output-type sequence)
"""

import argparse
import math
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


DEFAULTS = dict(
    skip=2,
    width=800,
    webp_quality=85,
    rembg_model='u2net',
    output_type='montage',
    output_dir='.',
    output='sprite.webp',      # for montage
    output_template='frame_{:03d}.webp',  # for sequence
)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog='p360-process',
        description='Convert a turntable video into a 360° spin viewer asset.',
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )

    p.add_argument('video', help='Input video file (mp4, mov, …)')

    # Output
    p.add_argument('--output-dir', '-d',
                   default=DEFAULTS['output_dir'],
                   help='Directory to write output files into')
    p.add_argument('--output', '-o',
                   default=None,
                   help='Output filename. For montage: sprite filename (default: sprite.webp). '
                        'For sequence: filename template with {:03d} placeholder '
                        '(default: frame_{:03d}.webp)')
    p.add_argument('--output-type', '-t',
                   choices=['montage', 'sequence'],
                   default=DEFAULTS['output_type'],
                   help='Output format: single sprite sheet or image sequence')

    # Frame extraction
    p.add_argument('--skip', '-s',
                   type=int, default=DEFAULTS['skip'],
                   help='Keep every (skip+1)th frame. '
                        '0=all frames, 1=every other, 2=every third (default), 3=every fourth, …')

    # Image processing
    p.add_argument('--width', '-w',
                   type=int, default=DEFAULTS['width'],
                   help='Width to scale each frame to (height is auto-computed to preserve aspect ratio)')
    p.add_argument('--webp-quality', '-q',
                   type=int, default=DEFAULTS['webp_quality'],
                   help='WebP lossy quality (1–100)')

    # Background removal
    p.add_argument('--no-rembg',
                   action='store_true',
                   help='Skip background removal')
    p.add_argument('--rembg-model',
                   default=DEFAULTS['rembg_model'],
                   help='rembg model to use (u2net, u2netp, isnet-general-use, …)')

    # Housekeeping
    p.add_argument('--keep-frames',
                   action='store_true',
                   help='Keep intermediate frame files after building sprite sheet')
    p.add_argument('--dry-run',
                   action='store_true',
                   help='Print commands without executing them')

    return p.parse_args()


# OS wrappers and utilities

def run(cmd: list[str], dry_run: bool = False) -> None:
    print('▶', ' '.join(str(c) for c in cmd))
    if not dry_run:
        result = subprocess.run(cmd, capture_output=False)
        if result.returncode != 0:
            sys.exit(f'Command failed with exit code {result.returncode}')


def check_dependency(name: str, hint: str = '') -> None:
    if shutil.which(name) is None:
        msg = f"Required tool '{name}' not found in PATH."
        if hint:
            msg += f' {hint}'
        sys.exit(msg)


def auto_cols(n: int) -> int:
    """Choose number of columns to make the sprite sheet as square as possible."""
    return round(math.sqrt(n))


def probe_frame_count(video: Path) -> int:
    """Use ffprobe to get the total frame count of the video."""
    result = subprocess.run(
        ['ffprobe', '-v', 'quiet',
         '-select_streams', 'v:0',
         '-count_packets',
         '-show_entries', 'stream=nb_read_packets',
         '-print_format', 'csv=p=0',
         str(video)],
        capture_output=True, text=True,
    )
    try:
        return int(result.stdout.strip())
    except ValueError:
        return 0


# pipeline:

def step_extract(video: Path, frames_dir: Path, skip: int, width: int,
                 dry_run: bool) -> int:
    """Extract frames from video, return number of frames written."""
    frames_dir.mkdir(parents=True, exist_ok=True)
    select = f'not(mod(n,{skip + 1}))' if skip > 0 else 'gte(n,0)'
    run([
        'ffmpeg', '-y', '-i', str(video),
        '-vf', f"select='{select}',scale={width}:-1",
        '-vsync', 'vfr',
        str(frames_dir / 'frame_%03d.png'),
    ], dry_run)
    if dry_run:
        total = probe_frame_count(video)
        return max(1, total // (skip + 1))
    frames = sorted(frames_dir.glob('frame_*.png'))
    return len(frames)


def step_rembg(frames_dir: Path, nobg_dir: Path, model: str, dry_run: bool) -> None:
    """Remove background from all frames in frames_dir → nobg_dir."""
    nobg_dir.mkdir(parents=True, exist_ok=True)
    run(['rembg', 'p', '-m', model, str(frames_dir), str(nobg_dir)], dry_run)


def step_convert_webp(src_dir: Path, webp_dir: Path, quality: int,
                      dry_run: bool) -> list[Path]:
    """Convert PNG frames to WebP, return sorted list of output paths."""
    webp_dir.mkdir(parents=True, exist_ok=True)
    pngs = sorted(src_dir.glob('frame_*.png'))
    for png in pngs:
        out = webp_dir / (png.stem + '.webp')
        run([
            'ffmpeg', '-y', '-i', str(png),
            '-c:v', 'libwebp', '-lossless', '0', '-quality', str(quality),
            str(out),
        ], dry_run)
    if dry_run:
        return []
    return sorted(webp_dir.glob('frame_*.webp'))


def embed_xmp(path: Path, meta: dict) -> None:
    """Embed p360 metadata as XMP into a WebP file via Pillow."""
    from PIL import Image
    fields = ''.join(f'<p360:{k}>{v}</p360:{k}>' for k, v in meta.items())
    xmp = (
        '<x:xmpmeta xmlns:x="adobe:ns:meta/">'
        '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        '<rdf:Description xmlns:p360="https://nicegui-p360/1.0/">'
        f'{fields}'
        '</rdf:Description></rdf:RDF></x:xmpmeta>'
    )
    with Image.open(path) as img:
        img.save(path, format='WEBP', xmp=xmp.encode(), lossless=False)


def step_montage(webp_dir: Path, output: Path, cols: int, frame_w: int,
                 frame_h: int, dry_run: bool) -> None:
    """Pack WebP frames into a sprite sheet using ImageMagick montage."""
    rows = math.ceil(len(list(webp_dir.glob('frame_*.webp'))) / cols)
    run([
        'montage',
        str(webp_dir / 'frame_*.webp'),
        '-tile', f'{cols}x{rows}',
        '-geometry', f'{frame_w}x{frame_h}+0+0',
        '-background', 'none',
        str(output),
    ], dry_run)


def main() -> None:
    args = parse_args()

    video = Path(args.video)
    if not video.exists():
        sys.exit(f"Input video not found: {video}")

    # Check required external tools
    check_dependency('ffmpeg',  hint='Install via your package manager.')
    check_dependency('ffprobe', hint='Usually bundled with ffmpeg.')
    if not args.no_rembg:
        check_dependency('rembg', hint='pip install rembg[gpu]')
    if args.output_type == 'montage':
        check_dependency('montage', hint='Install ImageMagick.')

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Resolve output filename/template
    if args.output is not None:
        output_name = args.output
    elif args.output_type == 'montage':
        output_name = DEFAULTS['output']
    else:
        output_name = DEFAULTS['output_template']
    assert type(output_name) is str, "Output name must be a string"

    print(f'\n=== p360-process: {video.name} ===\n')

    with tempfile.TemporaryDirectory(prefix='p360_') as tmp:
        tmp = Path(tmp)
        frames_dir = tmp / 'frames'
        nobg_dir = tmp / 'nobg'
        webp_dir = tmp / 'webp'

        print('\n[1/4] Extracting frames…')
        n_frames = step_extract(video, frames_dir, args.skip, args.width, args.dry_run)
        print(f'      → {n_frames} frames extracted')

        if args.no_rembg:
            print('\n[2/4] Background removal skipped (--no-rembg)')
            nobg_dir = frames_dir  # use raw frames as-is
        else:
            print(f'\n[2/4] Removing backgrounds (model: {args.rembg_model})…')
            step_rembg(frames_dir, nobg_dir, args.rembg_model, args.dry_run)

        print(f'\n[3/4] Converting to WebP (quality {args.webp_quality})…')
        webp_files = step_convert_webp(nobg_dir, webp_dir, args.webp_quality, args.dry_run)

        if args.output_type == 'montage':
            cols = auto_cols(n_frames)
            print(f'\n[4/4] Building sprite sheet ({cols} columns)…')
            # We need actual frame dimensions — probe first webp
            frame_w, frame_h = args.width, 0
            if webp_files:
                from PIL import Image
                with Image.open(webp_files[0]) as im:
                    frame_w, frame_h = im.size
            elif not args.dry_run:
                sys.exit('No WebP frames found — something went wrong in step 3.')

            output_path = output_dir / output_name
            step_montage(webp_dir, output_path, cols, frame_w, frame_h, args.dry_run)

            if not args.dry_run:
                embed_xmp(output_path, {
                    'frame_count':  n_frames,
                    'cols':         cols,
                    'frame_width':  frame_w,
                    'frame_height': frame_h,
                })
                size_kb = output_path.stat().st_size // 1024
                print(f'\n✓ Sprite sheet written: {output_path}  ({size_kb} KB)')
                print(f'  Frames: {n_frames}  |  Grid: {cols}×{math.ceil(n_frames/cols)}  |  Frame size: {frame_w}×{frame_h}')

        else:  # sequence
            print('\n[4/4] Copying sequence to output dir...')
            final_files = []
            for i, src in enumerate(sorted(webp_dir.glob('frame_*.webp')), start=1):
                dst = output_dir / output_name.format(i)
                if not args.dry_run:
                    shutil.copy2(src, dst)
                    final_files.append(dst)
                else:
                    print(f'  {src} → {dst}')

            if not args.dry_run:
                total_kb = sum(f.stat().st_size for f in final_files) // 1024
                print(f'\n✓ Sequence written: {len(final_files)} files in {output_dir}  ({total_kb} KB total)')

        if args.keep_frames and not args.dry_run:
            kept = output_dir / 'frames_webp'
            shutil.copytree(webp_dir, kept, dirs_exist_ok=True)
            print(f'  Intermediate frames kept in: {kept}')

    print()


if __name__ == '__main__':
    main()
