# Handoff: Contrast Pass + Default Chart Style

## Overview
Small visual-tuning patch to `public/index.html`. Two unrelated changes:
1. **Contrast bump** on faint UI (filter chips, news tags, footer version, news titles, base muted/dim CSS vars).
2. **Default chart style** flipped from `"area"` to `"bar"` (user preference, set via in-page Tweaks panel).

This is **not a redesign** — it's a small, targeted edit. Apply the diffs as-is to the target file.

## Files affected
- `public/index.html` — only file touched.

## Fidelity
**High-fidelity** — exact values below; copy verbatim.

---

## Change 1 — CSS custom properties (`:root` block)

Faint text was reading too low across the dark theme. Lighten both muted tiers.

```diff
   --text: #e8e8ec;
-  --muted: #5a5a68;
-  --dim: #2e2e38;
+  --muted: #8e8e9a;
+  --dim: #50505c;
```

Cascades to: section labels, ticker symbols, footer text, low-priority metadata across the page.

---

## Change 2 — `chipStyle()` (filter chips above the news feed)

The "ALL / XAU / XAG / …" filter strip was almost invisible inactive.

```diff
 function chipStyle(active) {
   return {
-    background:    active ? 'var(--dim)' : 'rgba(255,255,255,0.04)',
-    border:        '1px solid ' + (active ? 'var(--border-strong)' : 'rgba(255,255,255,0.14)'),
-    color:         active ? 'var(--text)' : 'rgba(232,232,236,0.55)',
+    background:    active ? 'var(--dim)' : 'rgba(255,255,255,0.06)',
+    border:        '1px solid ' + (active ? 'var(--border-strong)' : 'rgba(255,255,255,0.22)'),
+    color:         active ? 'var(--text)' : 'rgba(232,232,236,0.82)',
     fontFamily:    'var(--font-mono)',
-    fontSize:      9,
+    fontSize:      10,
     letterSpacing: '0.1em',
-    padding:       '3px 8px',
+    padding:       '4px 10px',
     cursor:        'pointer',
     textTransform: 'uppercase',
     transition:    'all 0.12s',
   };
 }
```

---

## Change 3 — News card metal tags (inside `NewsCard`)

Tags rendered next to article source were dimmed by an extra `opacity: 0.75` on top of the colored border. Remove it — the metal accent color already has plenty of saturation contrast.

```diff
                 border:        `1px solid ${m.cssColor}`,
                 padding:       '2px 7px',
-                opacity:       0.75,
                 textTransform: 'uppercase',
               }}>{tag}</span>
```

---

## Change 4 — News card title color

The hover/idle title color spread was too narrow; idle state was muddy.

```diff
       <a href={item.link} target="_blank" rel="noopener noreferrer" style={{
         fontFamily:    'var(--font-sans)',
         fontSize:      13,
         fontWeight:    500,
-        color:         hovered ? 'var(--text)' : 'oklch(0.78 0.015 240)',
+        color:         hovered ? 'var(--text)' : 'oklch(0.90 0.012 240)',
         textDecoration:'none',
         lineHeight:    1.35,
         transition:    'color 0.12s',
       }}>{item.title}</a>
```

---

## Change 5 — Footer version stamp

Was double-dimmed (`var(--dim)` + `opacity: 0.5`). Drop the opacity and bump to muted.

```diff
           {appVersion && (
-            <span style={{ fontSize:10, fontFamily:'var(--font-mono)', color:'var(--dim)', letterSpacing:'0.06em', opacity:0.5 }}>
+            <span style={{ fontSize:10, fontFamily:'var(--font-mono)', color:'var(--muted)', letterSpacing:'0.06em' }}>
               v{appVersion}
             </span>
           )}
```

---

## Change 6 — Default chart style → `bar`

Inside the `TWEAK_DEFAULTS` JSON block. The user toggled this via the live Tweaks panel and it persisted; carry the new default into the codebase.

```diff
 const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
   "layout": "editorial",
   "density": "comfortable",
-  "chartStyle": "area",
+  "chartStyle": "bar",
   "showChange": true,
   "accentStrength": "medium",
   "colorScheme": "dark"
 }/*EDITMODE-END*/;
```

---

## Verification checklist
After applying:
- [ ] News filter chips above the feed are clearly readable when inactive (white-ish text, not gray haze).
- [ ] Metal tags (e.g. `XAU`, `XCU`) on news cards render at full color, no fade.
- [ ] News headlines are near-white before hover, fully white on hover.
- [ ] Footer "v0.x.x" is visible without squinting.
- [ ] Sparkline charts default to bar style on first load (clear localStorage / EDITMODE block to test).
- [ ] Section labels ("SPOT PRICES", "PRECIOUS METALS", "MARKET NEWS") read at a comfortable mid-gray.

## Design tokens (after this patch)
| Token | Value |
|---|---|
| `--bg` | `#080809` |
| `--surface` | `#0f0f11` |
| `--border` | `#1c1c20` |
| `--border-strong` | `#2a2a30` |
| `--text` | `#e8e8ec` |
| `--muted` | `#8e8e9a` *(was `#5a5a68`)* |
| `--dim` | `#50505c` *(was `#2e2e38`)* |

No other tokens, components, layouts, or behaviors changed.
