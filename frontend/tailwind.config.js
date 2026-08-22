/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    /**
     * The export's "No Edge" rule: 24px gutter on mobile, 64px from lg up, and a
     * 1280px fixed centre column on desktop.
     */
    container: {
      center: true,
      padding: { DEFAULT: '1.5rem', lg: '4rem' },
      screens: { '2xl': '1280px' },
    },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        /** 1px ink outline for inputs and discrete UI edges. */
        'border-strong': 'hsl(var(--border-strong))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',

        /** Tonal ladder. Depth in this system is a surface step, never a shadow. */
        'surface-low': 'hsl(var(--surface-low))',
        'card-alt': 'hsl(var(--card-alt))',

        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        success: {
          DEFAULT: 'hsl(var(--success))',
          foreground: 'hsl(var(--success-foreground))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))',
        },

        /**
         * Signal colours. Reserved for status, the primary path and urgency —
         * never decorative, never a gradient, never a page background.
         *
         * `lime` is a FILL ONLY. On cream it is 1.27:1 as text and carries white at
         * 1.32:1; both are unusable. It always pairs with `on-lime` ink (12.95:1).
         */
        lime: {
          DEFAULT: 'hsl(var(--lime))',
          dim: 'hsl(var(--lime-dim))',
          foreground: 'hsl(var(--on-lime))',
        },
        cobalt: {
          DEFAULT: 'hsl(var(--cobalt))',
          deep: 'hsl(var(--cobalt-deep))',
          foreground: 'hsl(var(--on-cobalt))',
        },

        /** Inverted block — the brutalist "pop" achieved without a shadow. */
        panel: {
          DEFAULT: 'hsl(var(--panel))',
          foreground: 'hsl(var(--panel-foreground))',
        },

        /**
         * Seat map palette — the one place colour carries meaning rather than
         * decoration, so the states get first-class tokens.
         *
         * Six states, not the export's four: it merged "held by you" with "held by
         * someone else", and that distinction decides whether a seat is yours to
         * pay for. `available` and `mine` are light fills whose 3:1 boundary comes
         * from a 1px ink border rather than the fill itself.
         */
        seat: {
          available: 'hsl(var(--seat-available))',
          selected: 'hsl(var(--seat-selected))',
          mine: 'hsl(var(--seat-mine))',
          taken: 'hsl(var(--seat-taken))',
          offered: 'hsl(var(--seat-offered))',
          booked: 'hsl(var(--seat-booked))',
        },
      },

      /**
       * Sharp. `--radius` is 0rem, and the shadcn primitives derive lg/md/sm from
       * it, so every button, input, card and dialog goes square without a single
       * component edit. `pill` is kept only so nothing that references it breaks;
       * it is deliberately unused in this system.
       */
      borderRadius: {
        none: '0',
        sm: 'var(--radius)',
        md: 'var(--radius)',
        lg: 'var(--radius)',
        xl: 'var(--radius)',
        '2xl': 'var(--radius)',
        full: '9999px',
      },

      fontFamily: {
        /** Body and all UI text. Neutral, legible in dense reservation grids. */
        sans: ['"Public Sans"', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        /**
         * Display face. Anton — condensed, single weight 400, high impact. Never
         * ask for a bold weight: synthetic emboldening smears it. See index.css.
         */
        display: ['Anton', '"Public Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },

      /**
       * Type scale from the export's DESIGN.md, made fluid with clamp() so one
       * token covers mobile through desktop. Stitch specified 80px hero desktop /
       * 32px headline mobile; the clamps interpolate between those anchors.
       */
      fontSize: {
        'display-hero': ['clamp(2.75rem, 8vw, 5rem)', { lineHeight: '1', letterSpacing: '-0.02em' }],
        'display-lg': ['clamp(2rem, 5vw, 3rem)', { lineHeight: '1.1', letterSpacing: '0.01em' }],
        'display-md': ['clamp(1.5rem, 3vw, 2rem)', { lineHeight: '1.1', letterSpacing: '0.01em' }],
        'display-sm': ['1.25rem', { lineHeight: '1.15', letterSpacing: '0.01em' }],
        'body-md': ['1rem', { lineHeight: '1.6' }],
        'body-sm': ['0.875rem', { lineHeight: '1.5' }],
        'label-caps': ['0.75rem', { lineHeight: '1.2', letterSpacing: '0.08em', fontWeight: '700' }],
        'ui-action': ['0.9375rem', { lineHeight: '1', fontWeight: '600' }],
      },

      /** 4px baseline grid, with the export's named steps layered on top. */
      spacing: {
        xs: '0.25rem',
        sm: '0.5rem',
        md: '1rem',
        lg: '2rem',
        xl: '4rem',
        gutter: '1rem',
        /** Minimum comfortable seat target — see WCAG 2.5.8 note below. */
        seat: '1.75rem',
        'seat-touch': '2rem',
      },

      /**
       * Shadows are removed by design. The keys are retained and mapped to `none`
       * so any component still referencing them renders flat instead of silently
       * losing its class — they get cleaned up as each page is reworked.
       *
       * `hard` is the one permitted exception: a zero-blur offset block, which is
       * a brutalist device rather than a simulation of depth.
       */
      boxShadow: {
        /*
         * Tailwind's own scale is flattened too, not just the legacy custom keys.
         * Overriding only `card`/`glow`/etc. left DEFAULT, sm, md, lg, xl, 2xl and
         * inner resolving to real Tailwind shadows — and a stray
         * `data-[state=active]:shadow` on the tab trigger rendered one for real.
         * Mapping the whole scale to `none` makes the no-shadow rule structural
         * rather than something every component has to remember.
         */
        none: 'none',
        DEFAULT: 'none',
        sm: 'none',
        md: 'none',
        lg: 'none',
        xl: 'none',
        '2xl': 'none',
        inner: 'none',
        card: 'none',
        'card-hover': 'none',
        glow: 'none',
        'glow-strong': 'none',
        hard: '4px 4px 0 0 hsl(var(--border-strong))',
        'hard-sm': '2px 2px 0 0 hsl(var(--border-strong))',
      },

      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        /**
         * Fires when a seat changes state from a socket event. Scale only — no
         * glow, which this system rejects — so a remote change is noticeable
         * without softening the square.
         */
        'seat-pop': {
          '0%': { transform: 'scale(1)' },
          '45%': { transform: 'scale(1.16)' },
          '100%': { transform: 'scale(1)' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        /**
         * Marks the seats you are holding. A hard two-step border flash rather than
         * a soft breathing glow: it reads as mechanical, and it animates only the
         * border colour, so the seat's label never loses contrast mid-cycle.
         */
        'hold-flash': {
          '0%, 100%': { borderColor: 'hsl(var(--border-strong))' },
          '50%': { borderColor: 'hsl(var(--cobalt))' },
        },
        'slide-up': {
          from: { transform: 'translateY(100%)' },
          to: { transform: 'translateY(0)' },
        },
        'value-bump': {
          '0%': { transform: 'translateY(0)' },
          '40%': { transform: 'translateY(-2px)' },
          '100%': { transform: 'translateY(0)' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        /** Steps, not eases. Mechanical precision over organic motion. */
        'seat-pop': 'seat-pop 240ms steps(4, end)',
        'hold-flash': 'hold-flash 1.6s steps(2, end) infinite',
        'slide-up': 'slide-up 200ms steps(5, end)',
        'value-bump': 'value-bump 200ms steps(3, end)',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
