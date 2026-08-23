import { useState } from 'react';
import { Clapperboard, Music4 } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { EventType } from '@/lib/api/types';

interface PosterProps {
  src: string;
  alt: string;
  type: EventType;
  className?: string;
  /** Poster art is decorative when a text title sits beside it. */
  decorative?: boolean;
  /**
   * Candidate widths. Without this, `sizes` is inert — the browser has one URL to
   * choose from — which is how a 390px phone ended up downloading the desktop asset.
   */
  srcSet?: string;
  sizes?: string;
  /** Eager-load the hero image; everything below the fold stays lazy. */
  priority?: boolean;
  /**
   * Photographic treatment. Defaults to `none` — full colour.
   *
   * The Stitch reference specified a monochrome set, and this defaulted to
   * `luminosity` to get it. That was the wrong trade for this product: poster art is
   * the primary way somebody tells a film still from a gig photo while scanning the
   * grid, and `luminosity` throws exactly that away. It keeps the image's lightness
   * and takes hue and saturation from the backdrop — which is `bg-card-alt`, a
   * near-neutral cream — so every photo collapsed into the same flat tonal grey.
   *
   * Both modes are kept as opt-ins because they are the correct tool when type has to
   * sit *over* an image, but nothing uses them by default:
   *
   *   `luminosity` — discards the image's own hue for the backdrop's. Monochrome.
   *   `multiply`   — keeps hue, drives the darks down. Reads as a colour photo.
   *   `none`       — untouched, full colour. The default.
   *
   * Prefer a scrim over a blend for legibility: it darkens only the band the text
   * occupies instead of flattening the whole photograph.
   */
  blend?: 'luminosity' | 'multiply' | 'none';
}

/**
 * Event artwork with a three-stage life: skeleton, image, tonal fallback.
 *
 * Imagery comes from a third-party placeholder service, so it will occasionally be
 * slow or unreachable. A broken-image glyph in a poster grid looks worse than no
 * image, so failure resolves to a flat `card-alt` block with the category glyph —
 * which still looks deliberate in a brutalist layout.
 *
 * Images render in full colour by default. See the `blend` prop for why the previous
 * monochrome default was dropped, and what to reach for when type sits over artwork.
 */
export function Poster({
  src,
  alt,
  type,
  className,
  decorative = false,
  srcSet,
  sizes,
  priority = false,
  blend = 'none',
}: PosterProps) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const Glyph = type === 'concert' ? Music4 : Clapperboard;

  return (
    /**
     * `isolate` matters: a blend mode composites against everything behind it in the
     * stacking context, so without an isolation boundary the image would blend with
     * the page rather than with its own container.
     */
    <div className={cn('relative isolate overflow-hidden bg-card-alt', className)}>
      {status === 'error' ? (
        <div aria-hidden className="absolute inset-0 grid place-items-center">
          <Glyph className="h-8 w-8 text-muted-foreground" />
        </div>
      ) : (
        <img
          src={src}
          srcSet={srcSet}
          alt={decorative ? '' : alt}
          aria-hidden={decorative || undefined}
          sizes={sizes}
          loading={priority ? 'eager' : 'lazy'}
          decoding="async"
          fetchPriority={priority ? 'high' : 'auto'}
          // Fires for a cache hit too, including one served from a warm preload, so
          // an already-cached hero resolves on its first commit rather than fading in.
          ref={(node) => {
            // A hero restored from cache can complete before React attaches onLoad,
            // and the event never replays — that left the image stuck at opacity-0,
            // showing an empty tonal block over a fully downloaded picture.
            if (node?.complete && node.naturalWidth > 0) setStatus('loaded');
          }}
          onLoad={() => setStatus('loaded')}
          onError={() => setStatus('error')}
          className={cn(
            // 200ms, down from 500ms. The fade is polish, but half a second of it runs
            // *after* the bytes have arrived and reads as part of the load delay.
            'absolute inset-0 h-full w-full object-cover transition-opacity duration-200',
            blend === 'luminosity' && 'opacity-90 mix-blend-luminosity',
            blend === 'multiply' && 'opacity-80 mix-blend-multiply',
            status === 'loaded' ? 'opacity-100' : 'opacity-0',
            // Re-apply the blend's own opacity after the load transition, which would
            // otherwise override it once `opacity-100` lands.
            status === 'loaded' && blend === 'luminosity' && 'opacity-90',
            status === 'loaded' && blend === 'multiply' && 'opacity-80'
          )}
        />
      )}
    </div>
  );
}
