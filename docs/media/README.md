# docs/media

Media referenced from the project [README](../../README.md). Drop captures here using these exact filenames so the markdown picks them up.

## Hero demo (top of README)

| File | Format | Notes |
| --- | --- | --- |
| `demo.mp4` | MP4, H.264, 30fps, ~10 to 20 sec | Used by the `<video>` tag. GitHub renders it natively. |
| `demo.gif` | GIF, looping, max ~5 MB | Fallback for npm and other markdown renderers. Use a tool like [Gifski](https://gif.ski/) to convert from the MP4. |

Aim for **1640x1000** at 30fps. Show: open project, scrub timeline, drag a clip, drop a text animation, hit play.

## Screenshots grid

PNG at **1600x1000** (or 2x retina), trimmed to the app window, no OS chrome.

| File | What to capture |
| --- | --- |
| `editor.png` | Whole editor window with a project loaded, preview playing, timeline populated |
| `timeline.png` | Tight crop on the timeline showing multi-track, snap guides, and a razor or slip edit in progress |
| `text-animations.png` | Inspector or preview showcasing a text template like block-reveal or kinetic typography |
| `captions.png` | Captions panel after whisper has transcribed something, word-level segments visible |
| `inspector.png` | Inspector panel with keyframes visible on a transform or opacity track |
| `export.png` | Export dialog or progress UI, ideally mid-render |

## Capture tips (macOS)

```bash
# Screenshot of a window with shadow stripped
Cmd + Shift + 4, then Space, then Option + click window

# Screen recording
Cmd + Shift + 5 -> Record Selected Portion -> save as .mov
ffmpeg -i input.mov -vcodec libx264 -crf 23 -preset slow -movflags +faststart demo.mp4
ffmpeg -i demo.mp4 -vf "fps=24,scale=1640:-1:flags=lanczos" -loop 0 demo.gif
```

Keep total media in this folder under ~15 MB so the repo stays cloneable.
