/**
 * Per-frame compositor — Canvas2D twin of PreviewCanvas's ClipLayer + TextOverlay.
 *
 * Inputs: project geometry, the timeline (tracks + clips + transitions), the playhead
 * time in ms, and a FrameSource that can yield decoded `VideoFrame`s for any clip+time.
 *
 * Output: the provided OffscreenCanvas context is mutated to contain the composited
 * frame. The caller wraps it as a VideoFrame and pushes it to the encoder.
 */

import { parseEffects, type MotionEffect } from '@/utils/motion-fx';
import { parseKeyframes, valueAt, valuesAt } from '@/utils/keyframes';
import { computeTransitionStates, transitionFadeMultiplier } from '@/utils/transitions';
import { activeTranscriptEntry, parseTextAnimation, computeTextAnimation } from '@/utils/text-animation';
import { gradeToCSS } from '@/utils/color';
import { computeMotionFxCanvas, parseCssTransform } from './motion-fx-canvas';
import { applyTransitionClip, transitionVisualToCanvas } from './transitions-canvas';
import { measureTextBlock, renderTextClip } from './text-renderer';
import type { FrameSource } from './frame-source';
import type { Clip, ColorGrade, MediaAsset, Track, Transition } from '@shared/types';

type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export interface CompositorInputs {
  ctx: Ctx2D;
  width: number;
  height: number;
  tracks: Track[];
  clips: Clip[];
  transitions: Transition[];
  assets: MediaAsset[];
  frameSource: FrameSource;
  /**
   * Scale factor applied to preview-pixel values (font_size, position offsets, motion-FX
   * translates, shadow sizes). The editor stores these as CSS pixels in the preview's
   * visible canvas size, so a font_size of 56 looks right at a 400-wide preview but is
   * tiny at the export's 1080. previewScale = exportWidth / previewWidth normalizes it.
   * Default 1 means "render at raw stored values" (same look as the legacy export).
   */
  previewScale: number;
}

function parseGrade(json: string | null): Partial<ColorGrade> | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as Partial<ColorGrade>;
  } catch {
    return null;
  }
}

/**
 * Render one frame at `playheadMs` to {@link CompositorInputs.ctx}. Returns once the
 * frame has been fully painted. All VideoFrames pulled from the source are closed.
 */
export async function renderFrame(
  inputs: CompositorInputs,
  playheadMs: number,
): Promise<void> {
  const { ctx, width: W, height: H, tracks, clips, transitions, assets, frameSource, previewScale: S } = inputs;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  // High-quality bilinear/bicubic upscaling — without this, drawing a 540p proxy frame
  // into a 1080p canvas produces visibly soft output compared to FFmpeg's scaling.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const orderedTracks = [...tracks].sort((a, b) => a.order_index - b.order_index);
  const videoTracks = orderedTracks.filter((t) => t.type === 'video');
  const textTracks = orderedTracks.filter(
    (t) => t.type === 'text' || t.type === 'sticker' || t.type === 'effect',
  );

  const transitionState = computeTransitionStates(playheadMs, clips, transitions);

  // Force-render set: clips that are off-time but participating in an active transition.
  const activeClips = clips.filter((c) => {
    const inRange = playheadMs >= c.start_time_ms && playheadMs < c.start_time_ms + c.duration_ms;
    return inRange || transitionState.forceRender.has(c.id);
  });

  // ---------- VIDEO CLIPS (bottom-up by track order) ----------
  for (const vt of videoTracks) {
    const clipsOnTrack = activeClips
      .filter((c) => c.track_id === vt.id)
      .sort((a, b) => a.start_time_ms - b.start_time_ms);

    for (const clip of clipsOnTrack) {
      const asset = assets.find((a) => a.id === clip.asset_id);
      if (!asset || asset.type === 'audio') continue;

      const relativeMs = playheadMs - clip.start_time_ms;
      const clipFrame = await frameSource.frameAt(clip, playheadMs);
      if (!clipFrame) continue;

      // ---- Compose transforms (keyframes + static clip xform + motion FX + transition) ----
      const kfTracks = parseKeyframes(clip.effects_json);
      const kfValues = valuesAt(kfTracks, relativeMs);
      const posX = kfValues.position_x ?? clip.position_x;
      const posY = kfValues.position_y ?? clip.position_y;
      const sclX = kfValues.scale_x ?? clip.scale_x;
      const sclY = kfValues.scale_y ?? clip.scale_y;
      const rotDeg = kfValues.rotation ?? clip.rotation;
      const opacity = (kfValues.opacity ?? clip.opacity) *
        (transitionState.byClip.get(clip.id)?.opacity ?? 1);

      const motionFx = computeMotionFxCanvas(
        parseEffects(clip.effects_json) as MotionEffect[],
        relativeMs,
        clip.duration_ms,
      );
      const trVisual = transitionVisualToCanvas(transitionState.byClip.get(clip.id), W, H, S);

      ctx.save();
      ctx.globalAlpha *= Math.max(0, Math.min(1, opacity));

      // Reveal-mask transitions (wipe, iris). Apply with CTM at identity so the clip
      // region is baked into canvas-pixel space — subsequent translate/rotate/scale for
      // the clip's own transform don't move the mask.
      if (trVisual.clipShape) {
        applyTransitionClip(ctx, trVisual.clipShape, W, H);
      }

      // Composite filters: grade + motion-fx + transition.
      const grade = parseGrade(clip.color_grade_json);
      const gradeStr = grade ? gradeToCSS(grade) : '';
      const filterCombined = [gradeStr, motionFx.filter, trVisual.filter]
        .filter((s) => s && s.length > 0)
        .join(' ');
      ctx.filter = filterCombined || 'none';

      // Apply transforms in the same order the preview composes them:
      //  - translate to canvas center (so rotation/scale pivot is centered)
      //  - apply clip's position offset
      //  - apply motion-fx + transition translates
      //  - rotate
      //  - apply motion-fx + transition rotates
      //  - scale (clip * motion-fx * transition)
      //  - translate back to top-left
      const totalScaleX = sclX * motionFx.scaleX * trVisual.scaleX;
      const totalScaleY = sclY * motionFx.scaleY * trVisual.scaleY;
      const totalRotRad =
        (rotDeg * Math.PI) / 180 + motionFx.rotateRad + trVisual.rotateRad;
      // posX/posY and motion-FX translates are in preview-pixels → scale by S. Transition
      // translates were already converted to export-pixel space inside
      // transitionVisualToCanvas (the %-to-px conversion used W/H), so they're added in
      // unscaled. Double-scaling them was making slides over-shoot and clips vanish
      // from the canvas well before the fade portion could appear.
      const totalTx = (posX + motionFx.translateX) * S + trVisual.translateX;
      const totalTy = (posY + motionFx.translateY) * S + trVisual.translateY;

      ctx.translate(W / 2 + totalTx, H / 2 + totalTy);
      ctx.rotate(totalRotRad);
      ctx.scale(totalScaleX, totalScaleY);
      ctx.translate(-W / 2, -H / 2);

      // Draw the frame cover-fitted into the canvas (matches PreviewCanvas's
      // object-fit: cover).
      drawCover(ctx, clipFrame.source, clipFrame.width, clipFrame.height, W, H);

      ctx.restore();
    }
  }

  // ---------- TEXT/STICKER OVERLAYS (top, in track order) ----------
  // Compute the active transition fade multiplier ONCE per frame; reused across all
  // text clips that opt in to following adjacent video transitions.
  const txnFadeMult = transitionFadeMultiplier(playheadMs, clips, transitions);

  for (const tt of textTracks) {
    const clipsOnTrack = activeClips
      .filter((c) => {
        if (c.track_id !== tt.id) return false;
        if (c.text_content) return true;
        // Compound or transcript-mode clips can have empty text_content but
        // still render via their subtitle row or active transcript entry.
        if (!c.text_animation_json) return false;
        try {
          const raw = JSON.parse(c.text_animation_json) as Record<string, unknown>;
          return (
            Array.isArray(raw.transcript_entries) ||
            typeof raw.subtitle_text === 'string'
          );
        } catch {
          return false;
        }
      })
      .sort((a, b) => a.start_time_ms - b.start_time_ms);

    for (const clip of clipsOnTrack) {
      const relativeMs = playheadMs - clip.start_time_ms;
      let style: Record<string, unknown> = {};
      try {
        style = clip.text_style_json ? JSON.parse(clip.text_style_json) : {};
      } catch {
        // ignore malformed style
      }
      const anim = parseTextAnimation(clip.text_animation_json);
      const visual = computeTextAnimation(
        clip.text_content ?? '',
        relativeMs,
        clip.duration_ms,
        anim,
      );
      // Transcript mode: pick the entry whose window contains the playhead.
      // If we're between entries, skip drawing this clip entirely so the
      // exported frame matches the live preview.
      const transcriptMode =
        anim.transcript_entries !== undefined && anim.transcript_entries.length > 0;
      const transcriptActive = transcriptMode
        ? activeTranscriptEntry(anim.transcript_entries, relativeMs)
        : null;
      if (transcriptMode && !transcriptActive) continue;
      // Optional fade at entry boundaries — mirrors the preview math.
      const transcriptFadeMult = (() => {
        if (!transcriptMode || !transcriptActive) return 1;
        const fade = anim.transcript_fade_ms ?? 0;
        if (fade <= 0) return 1;
        const intoEntry = relativeMs - transcriptActive.startMs;
        const beforeEnd = transcriptActive.endMs - relativeMs;
        const a = Math.min(1, Math.max(0, intoEntry / fade));
        const b = Math.min(1, Math.max(0, beforeEnd / fade));
        return Math.min(a, b);
      })();
      // Per-clip opt-in: when on, the text's own animation opacity is multiplied by the
      // V-shape curve of any overlapping video transition.
      const effectiveOpacity =
        (anim.fade_with_transition ? visual.opacity * txnFadeMult : visual.opacity) *
        transcriptFadeMult;
      // Transcript mode: title comes from the active entry, not text_content.
      const renderedText = transcriptActive
        ? transcriptActive.title
        : visual.visibleText ?? clip.text_content ?? '';
      // Allow empty-string entries to still draw the subtitle row below — only
      // skip when BOTH are empty (and we're not in transcript mode).
      if (!renderedText && !(transcriptActive && transcriptActive.subtitle)) continue;

      // Center the text overlay at the preview's bottom-12% baseline + position offsets.
      const baseY = H * 0.88;
      const kfTracks = parseKeyframes(clip.effects_json);
      const px = valueAt(kfTracks, 'position_x', relativeMs) ?? clip.position_x;
      const py = valueAt(kfTracks, 'position_y', relativeMs) ?? clip.position_y;
      // User-set text scale (via corner-drag in the preview or the Size slider in the
      // inspector). Keyframes override when present, otherwise the clip's static scale.
      const userSclX = valueAt(kfTracks, 'scale_x', relativeMs) ?? clip.scale_x ?? 1;
      const userSclY = valueAt(kfTracks, 'scale_y', relativeMs) ?? clip.scale_y ?? 1;

      // Animation transform: the same parser handles its translate/scale/rotate.
      const animXform = parseCssTransform(visual.transform);

      ctx.save();
      ctx.filter = visual.filter && visual.filter.length > 0 ? visual.filter : 'none';

      // Anchor in export-pixels, then switch to preview-pixel space so font_size,
      // padding, shadow offsets, glow radii — every pixel value inside renderTextClip
      // — naturally scales to look right at export resolution.
      const baseRotDeg = typeof style.rotation_deg === 'number' ? (style.rotation_deg as number) : 0;
      ctx.translate(W / 2, baseY);
      ctx.scale(S, S);
      ctx.translate(px + animXform.translateX, py + animXform.translateY);
      ctx.rotate((baseRotDeg * Math.PI) / 180 + animXform.rotateRad);
      // Compose user scale with animation scale — both are unitless multipliers on the
      // canvas's transformed coordinate system.
      ctx.scale(userSclX * animXform.scaleX, userSclY * animXform.scaleY);

      // Compound layout: when there's a subtitle row, compute both rows'
      // rendered heights up-front so we can stack them without overlap.
      // The editor preview gets this for free via CSS flexbox column;
      // Canvas2D has no flow layout, so we measure + place manually.
      // Anchor convention matches the editor: the COMPOUND'S BOTTOM EDGE sits
      // at baseY (the bottom-12% line). Everything stacks upward from there.
      const wrapWidth = (W * 0.8) / S;
      const subText = transcriptActive ? transcriptActive.subtitle : anim.subtitle_text;
      let subStyle: Record<string, unknown> = style;
      if (anim.subtitle_style_json) {
        try {
          subStyle = JSON.parse(anim.subtitle_style_json) as Record<string, unknown>;
        } catch {
          // Fall back to the title style if the subtitle JSON is malformed.
        }
      }
      const hasSubtitle = !!(subText && subText.length > 0);
      // Vertical gap between the two rows (in preview-pixel units).
      const stackGap = 6;

      let titleCenterY = 0;
      let subCenterY = 0;
      if (hasSubtitle) {
        const titleBlock = measureTextBlock(
          ctx,
          renderedText,
          style as Partial<import('@/utils/text-templates').TextStyleFull>,
          wrapWidth,
        );
        const subBlock = measureTextBlock(
          ctx,
          subText as string,
          subStyle as Partial<import('@/utils/text-templates').TextStyleFull>,
          wrapWidth,
        );
        // Anchor the compound's bottom edge at the origin (which the outer
        // ctx.translate already places at baseY). Then walk upward:
        //   subtitle bottom = 0   → subtitle center = -subBlock.height / 2
        //   title bottom    = -subBlock.height - gap → title center = title bottom - titleBlock.height/2
        subCenterY = -subBlock.height / 2;
        titleCenterY = -subBlock.height - stackGap - titleBlock.height / 2;
      }

      renderTextClip({
        ctx,
        centerX: 0,
        centerY: titleCenterY,
        text: renderedText,
        style,
        visual: { ...visual, opacity: effectiveOpacity },
        relativeMs,
        // Wrap at 80% of canvas width — same constraint the preview's wrapper enforces
        // via `maxWidth: 80%`. We're inside a scaled CTM (S = preview→export ratio), so
        // the wrap width has to be expressed in pre-scale units.
        maxWidth: wrapWidth,
      });

      if (hasSubtitle) {
        renderTextClip({
          ctx,
          centerX: 0,
          centerY: subCenterY,
          text: subText as string,
          style: subStyle,
          visual: { ...visual, opacity: effectiveOpacity },
          relativeMs,
          maxWidth: wrapWidth,
        });
      }

      ctx.restore();
    }
  }

  ctx.restore();
}

/**
 * Draw `source` into `[0, 0, dstW, dstH]` using object-fit: cover semantics — the source
 * is scaled to fill the destination while preserving aspect, cropping overflow.
 */
function drawCover(
  ctx: Ctx2D,
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): void {
  if (srcW <= 0 || srcH <= 0) {
    // Degenerate dimensions — just stretch the source to fill.
    ctx.drawImage(source, 0, 0, dstW, dstH);
    return;
  }
  const srcAR = srcW / srcH;
  const dstAR = dstW / dstH;
  let sx = 0;
  let sy = 0;
  let sw = srcW;
  let sh = srcH;
  if (srcAR > dstAR) {
    // Source is wider — crop horizontally.
    sw = srcH * dstAR;
    sx = (srcW - sw) / 2;
  } else if (srcAR < dstAR) {
    sh = srcW / dstAR;
    sy = (srcH - sh) / 2;
  }
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, dstW, dstH);
}
